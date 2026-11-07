"""Asset Transfer: receive files with croc, then move each one into the chosen
exhibition's artwork folder.

Runs as a GLOBAL node-pa-td plugin, so it lives in its own Engine COMP with no
access to Control's operators. Everything it knows about exhibitions comes
from disk (depository/exhibitions/*/exhibition.json). It never scans: the
operator runs the artwork scan in Control when the files are in place.

THREADING -- same model as ledControl:

  ReceiveWorker / MoveWorker (in the TD-free `transfer` module) run on daemon
  threads and post plain tuples to one queue.Queue. Tick(), called once per
  frame by exec_frame on the main thread, drains that queue and is the only
  place results meet TouchDesigner. Every path, code and relay value is
  resolved here on the main thread BEFORE a worker starts.

FLOW

  Receive(code)  -> ReceiveWorker: croc --out <staging>/<transfer-id>
                    (code in CROC_SECRET, never argv) -> files land in staging
  Move(path, id) -> MoveWorker: staging -> exhibitions/<id>/artwork/<name>
                    (refuses collisions; cross-drive copies via .partial)
  Discard(path)  -> delete a staged entry

Staging on disk is the record of what is waiting, so a restart loses nothing.
"""

import os
import queue
import shutil
import sys
import time
from pathlib import Path

transfer = mod('transfer')  # TD-free module DAT beside this one

MAX_MESSAGES = 60


class AssetTransferExt:

	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		self._events = queue.Queue()
		self._workers = {}        # transfer_id -> ReceiveWorker
		self.Transfers = {}       # transfer_id -> {state, percent, line, error, started}
		self.Moves = {}           # job_id -> {src, exhibition, state, error}
		self.Staged = []          # entries from transfer.all_staged
		self.Exhibitions = []     # from transfer.list_exhibitions
		self.Messages = []        # (time, level, text), newest last
		self._jobSeq = 0
		run('args[0].RefreshAll()', self, delayFrames=5)

	def onDestroyTD(self):
		for w in list(self._workers.values()):
			w.cancel()

	# ---- resolved settings (main thread only) -------------------------------

	@property
	def StagingFolder(self):
		p = str(self.ownerComp.par.Stagingfolder.eval()).strip()
		return Path(p) if p else transfer.default_staging()

	@property
	def DepositoryFolder(self):
		p = str(self.ownerComp.par.Depositoryfolder.eval()).strip()
		if p:
			return Path(p)
		return transfer.find_depository([project.folder, os.getcwd()])

	def _crocCommand(self):
		p = str(self.ownerComp.par.Crocpath.eval()).strip()
		if p:
			return [p]
		found = shutil.which('croc')
		if found:
			return [found]
		if sys.platform == 'win32':
			for candidate in (Path.home() / 'scoop' / 'shims' / 'croc.exe',
			                  Path(os.environ.get('ProgramData', r'C:\ProgramData')) / 'chocolatey' / 'bin' / 'croc.exe'):
				if candidate.exists():
					return [str(candidate)]
		return None

	# ---- public actions -------------------------------------------------------

	def Receive(self, code=None):
		"""Start a croc receive into a new staging folder. Returns the transfer
		id, or None after posting the reason it refused."""
		code = (code if code is not None else str(self.ownerComp.par.Code.eval())).strip()
		if not code:
			return self._refuse('Enter the code phrase the sender gave you.')
		croc = self._crocCommand()
		if not croc:
			return self._refuse('croc is not installed or not on PATH -- set the Croc path parameter.')
		staging = self.StagingFolder
		try:
			staging.mkdir(parents=True, exist_ok=True)
		except OSError as e:
			return self._refuse('Cannot create staging folder %s: %s' % (staging, e))

		tid = transfer.new_transfer_id()
		worker = transfer.ReceiveWorker(
			tid, code, croc, staging, self._events,
			relay=str(self.ownerComp.par.Relay.eval()).strip(),
			relay_pass=str(self.ownerComp.par.Relaypass.eval()).strip())
		self._workers[tid] = worker
		self.Transfers[tid] = {'state': 'receiving', 'percent': None, 'line': 'starting croc...',
		                       'error': None, 'started': time.time()}
		self.ownerComp.par.Code = ''  # one-time code; do not leave it on screen
		worker.start()
		self._message('info', 'Receiving transfer %s...' % tid)
		return tid

	def Cancel(self, transfer_id=None):
		"""Cancel one receive, or every running receive when no id is given."""
		ids = [transfer_id] if transfer_id else list(self._workers)
		if not ids:
			return self._refuse('Nothing is receiving.')
		for tid in ids:
			w = self._workers.get(tid)
			if w is None:
				self._refuse('Transfer %s is not running.' % tid)
				continue
			w.cancel()
			self.Transfers[tid]['state'] = 'cancelling'
		self._notify()

	def Move(self, path, exhibition_id):
		"""Move one staged entry into an exhibition's artwork folder (on a
		worker -- a cross-drive move is a full copy)."""
		if not exhibition_id:
			return self._refuse('Choose an exhibition for %s first.' % Path(path).name)
		depository = self.DepositoryFolder
		if depository is None:
			return self._refuse('Depository not found -- set the Depository folder parameter.')
		if any(m['src'] == str(path) and m['state'] == 'moving' for m in self.Moves.values()):
			return self._refuse('%s is already being moved.' % Path(path).name)
		self._jobSeq += 1
		job = 'm%d' % self._jobSeq
		self.Moves[job] = {'src': str(path), 'exhibition': exhibition_id, 'state': 'moving', 'error': None}
		transfer.MoveWorker(job, path, self.StagingFolder, depository, exhibition_id, self._events).start()
		self._message('info', 'Moving %s -> %s/artwork...' % (Path(path).name, exhibition_id))
		return job

	def Discard(self, path):
		try:
			transfer.discard(path, self.StagingFolder)
			transfer.prune_empty_transfers(self.StagingFolder)
			self._message('info', 'Discarded %s.' % Path(path).name)
		except (transfer.TransferError, OSError) as e:
			self._refuse('Could not discard %s: %s' % (Path(path).name, e))
		self.RefreshStaged()

	def OpenStaging(self):
		staging = self.StagingFolder
		staging.mkdir(parents=True, exist_ok=True)
		ui.viewFile(str(staging))

	def RefreshAll(self):
		self.RefreshExhibitions()
		self.RefreshStaged()

	def RefreshExhibitions(self):
		depository = self.DepositoryFolder
		if depository is None:
			self.Exhibitions = []
			self._refuse('Depository not found -- set the Depository folder parameter.')
			return
		self.Exhibitions = transfer.list_exhibitions(depository)
		for e in self.Exhibitions:
			if e['warning']:
				self._message('warn', '%s: %s' % (e['id'], e['warning']))
		self._notify()

	def RefreshStaged(self):
		self.Staged = transfer.all_staged(self.StagingFolder)
		self._notify()

	# ---- frame pump -------------------------------------------------------------

	def Tick(self):
		"""Drain worker events. Main thread only (exec_frame)."""
		changed = False
		staged = False
		for _ in range(200):  # bounded per frame
			try:
				kind, key, data = self._events.get_nowait()
			except queue.Empty:
				break
			changed = True
			if kind == 'progress':
				t = self.Transfers.get(key)
				if t is not None:
					t['line'] = data['line']
					if data['percent'] is not None:
						t['percent'] = data['percent']
			elif kind == 'done':
				self._workers.pop(key, None)
				t = self.Transfers.setdefault(key, {})
				t['error'] = data['error']
				if data['ok']:
					t['state'] = 'received'
					names = ', '.join(e['name'] for e in data['entries'])
					self._message('info', 'Received %s.' % names)
					for e in data['entries']:
						if e['executable']:
							self._message('warn', '%s is a .tox: it runs code on every render. '
							              'Check where it came from before moving it.' % e['name'])
						elif not e['scannable']:
							self._message('warn', '%s is not a type the artwork scan picks up.' % e['name'])
				else:
					t['state'] = 'cancelled' if data['cancelled'] else 'failed'
					self._message('warn' if data['cancelled'] else 'error',
					              'Transfer %s: %s' % (key, data['error']))
				staged = True
			elif kind == 'moved':
				m = self.Moves.get(key, {})
				m['state'] = 'done' if data['ok'] else 'failed'
				m['error'] = data['error']
				if data['ok']:
					self._message('info', 'Moved to %s. Run the artwork scan in Control to add it.' % data['dest'])
				else:
					self._message('error', 'Move failed: %s' % data['error'])
				staged = True
		if staged:
			self.RefreshStaged()
		elif changed:
			self._notify()

	# ---- parameter relays -------------------------------------------------------

	def OnParPulse(self, name):
		if name == 'Receive':
			self.Receive()
		elif name == 'Cancel':
			self.Cancel()
		elif name == 'Refresh':
			self.RefreshAll()
		elif name == 'Openstaging':
			self.OpenStaging()

	# ---- helpers ----------------------------------------------------------------

	def _message(self, level, text):
		self.Messages.append((time.strftime('%H:%M:%S'), level, text))
		del self.Messages[:-MAX_MESSAGES]
		debug('[%s] %s' % (level, text))
		self._notify()

	def _refuse(self, text):
		"""Every declined action names its reason on screen -- never a silent no-op."""
		self._message('error', text)
		return None

	def _notify(self):
		panel = self.ownerComp.op('ui')
		if panel is not None and panel.extensionsReady and hasattr(panel, 'Paint'):
			panel.Paint()
