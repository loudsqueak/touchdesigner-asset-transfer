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
		self.Deliveries = {}      # delivery_id -> {exhibition, plan, transfer, state, ...}
		self._deliveryOf = {}     # transfer_id -> delivery_id
		self.ApiStatus = {'enabled': False, 'port': None, 'listening': False, 'reason': 'not checked yet'}
		self._nextApiCheck = 0.0
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
			for candidate in (Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'croc' / 'croc.exe',
			                  Path.home() / 'scoop' / 'shims' / 'croc.exe',
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

	# ---- deliveries (started by the send CLI through the api DAT) ---------------

	@property
	def ApiToken(self):
		"""The token senders must present: the Token parameter when set,
		otherwise one generated once and kept in ~/.asset-transfer/token."""
		p = str(self.ownerComp.par.Token.eval()).strip()
		return p if p else transfer.load_or_create_token(transfer.default_token_file())

	def StartDelivery(self, code, exhibition_id, plan):
		"""Receive with `code`, then place everything per `plan` into
		`exhibition_id` with no operator step. Returns the delivery dict.
		Raises ValueError with the reason when it refuses."""
		depository = self.DepositoryFolder
		if depository is None:
			raise ValueError('depository not found on Control -- set the Depository folder parameter')
		try:
			transfer.exhibition_dir(depository, exhibition_id)
		except transfer.TransferError as e:
			raise ValueError(str(e))
		if not isinstance(plan, dict) or not isinstance(plan.get('items'), dict):
			raise ValueError('plan must be {"items": {name: "artwork"|"plugin"}, "unzip": [...]}')
		bad = [k for k, v in plan['items'].items() if v not in ('artwork', 'plugin')]
		if bad:
			raise ValueError('unknown destination for %s' % ', '.join(bad))
		tid = self.Receive(code)
		if tid is None:
			raise ValueError(self.Messages[-1][2] if self.Messages else 'receive refused')
		self._jobSeq += 1
		did = 'd%d-%s' % (self._jobSeq, tid)
		self.Deliveries[did] = {'id': did, 'exhibition': exhibition_id, 'plan': plan, 'transfer': tid,
		                        'state': 'receiving', 'percent': None, 'line': '', 'results': [],
		                        'error': None, 'started': time.time()}
		self._deliveryOf[tid] = did
		plugins = [n for n, k in plan['items'].items() if k == 'plugin']
		if plugins:
			self._message('warn', 'Delivery %s will put %s into %s/plugins.' % (did, ', '.join(plugins), exhibition_id))
		return self.DeliveryStatus(did)

	def DeliveryStatus(self, delivery_id):
		"""Plain-data snapshot of one delivery, or None."""
		d = self.Deliveries.get(delivery_id)
		if d is None:
			return None
		t = self.Transfers.get(d['transfer'], {})
		out = {k: v for k, v in d.items() if k != 'plan'}
		if d['state'] == 'receiving':
			out['percent'] = t.get('percent')
			out['line'] = t.get('line') or ''
		return out

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
		if time.time() >= self._nextApiCheck:
			self._nextApiCheck = time.time() + 2.0
			self._checkApi()
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
				did = self._deliveryOf.pop(key, None)
				if did is not None:
					self._startDelivering(did, data)
				staged = True
			elif kind == 'delivered':
				d = self.Deliveries.get(key)
				if d is not None:
					d['state'] = 'done' if data['ok'] else 'failed'
					d['results'] = data['results']
					d['error'] = data['error']
				for r in data['results']:
					if r['error']:
						self._message('error', '%s: %s' % (r['name'], r['error']))
					else:
						self._message('info', 'Placed %s in %s.' % (r['name'], r['dest']))
				if data['error'] and not data['results']:
					self._message('error', 'Delivery %s failed: %s' % (key, data['error']))
				if any(r['dest'] and r['kind'] == 'artwork' for r in data['results']):
					self._message('info', 'Run the artwork scan in Control to add the new artwork.')
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

	def _checkApi(self):
		"""Is the api Web Server DAT really accepting connections, and on which
		port? The port comes from the DAT itself, so a value pushed in by the
		host Engine COMP shows here, not the .tox default. A localhost connect
		is answered or refused at once, so this never stalls the frame."""
		import socket
		api = self.ownerComp.op('api')
		status = {'enabled': bool(self.ownerComp.par.Apienable.eval()), 'port': None,
		          'listening': False, 'reason': ''}
		if api is None:
			status['reason'] = 'api DAT missing'
		else:
			status['port'] = int(api.par.port.eval())
			if not status['enabled']:
				status['reason'] = 'turned off (Enable API)'
			else:
				s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
				s.settimeout(0.2)
				try:
					status['listening'] = s.connect_ex(('127.0.0.1', status['port'])) == 0
				except OSError as e:
					status['reason'] = str(e)
				finally:
					s.close()
				# Something answering is not proof it is us (another program can
				# hold the port), so the DAT must also report no error or warning.
				problems = ' '.join(x for x in (api.errors(), api.warnings()) if x).strip()
				if problems:
					status['listening'] = False
					status['reason'] = problems
				elif not status['listening'] and not status['reason']:
					status['reason'] = 'nothing accepted a connection on that port'
		if status != self.ApiStatus:
			self.ApiStatus = status
			if status['listening']:
				self._message('info', 'Send CLI API listening on port %d.' % status['port'])
			elif status['enabled']:
				self._message('error', 'Send CLI API NOT listening on port %s: %s' % (status['port'], status['reason']))
			self._notify()

	def _startDelivering(self, did, data):
		d = self.Deliveries.get(did)
		if d is None:
			return
		if not data['ok']:
			d['state'] = 'failed'
			d['error'] = data['error']
			return
		depository = self.DepositoryFolder
		if depository is None:
			d['state'] = 'failed'
			d['error'] = 'depository not found on Control; files left in staging'
			return
		d['state'] = 'delivering'
		transfer.DeliveryWorker(did, self.StagingFolder / d['transfer'], self.StagingFolder, depository,
		                        d['exhibition'], d['plan'], self._events).start()

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
