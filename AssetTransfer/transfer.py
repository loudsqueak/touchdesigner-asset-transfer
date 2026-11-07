"""Receive files with croc and move them into an exhibition's artwork folder.

This module has NO TouchDesigner dependency -- it runs in a plain Python
shell, which is how tests/test_transfer.py exercises it. AssetTransferExt
calls into it from TD:

  * ReceiveWorker runs on its own daemon thread. It starts croc, reads its
    output, and reports through a queue.Queue as plain tuples. It never
    touches an operator, a parameter or storage; the extension drains the
    queue on the main thread once per frame.
  * list_exhibitions / staged_entries / move_to_artwork are short filesystem
    calls (a cross-drive move is a copy, so the extension runs those on a
    worker too).

Queue events (all plain data):

  ('progress', transfer_id, {'percent': int|None, 'line': str})
  ('done',     transfer_id, {'ok': bool, 'cancelled': bool, 'returncode': int|None,
                             'entries': [entry...], 'error': str|None, 'log': [str]})
  ('moved',    job_id,      {'ok': bool, 'dest': str|None, 'error': str|None})

An entry is {'name', 'path', 'isDir', 'bytes'}.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence

PARTIAL_SUFFIX = '.partial'
LOG_TAIL = 40

# What the depository's artwork scan picks up (ExhibitionExt._ScanArtworkSync).
# Anything else moves fine but will not become an artwork on Scan.
SCANNABLE = {'.mp4', '.mov', '.avi', '.mkv',
             '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp',
             '.tox'}
EXECUTABLE = {'.tox'}

_PERCENT = re.compile(r'(\d{1,3})%')


class TransferError(Exception):
	"""A move or receive refused for a reason the operator must see."""


# ---------------------------------------------------------------------------
# depository discovery
# ---------------------------------------------------------------------------

def find_depository(starts: Sequence[os.PathLike]) -> Optional[Path]:
	"""Walk up from each start folder to the first one holding
	depository/exhibitions. Returns that depository folder, or None."""
	for start in starts:
		if not start:
			continue
		here = Path(start).resolve()
		for folder in (here, *here.parents):
			candidate = folder / 'depository'
			if (candidate / 'exhibitions').is_dir():
				return candidate
	return None


def list_exhibitions(depository: os.PathLike) -> List[Dict[str, str]]:
	"""Every exhibition folder under depository/exhibitions, sorted by name.

	Name comes from exhibition.json; a folder whose json is missing or broken
	is still listed (by folder name) so the operator can see it, flagged with
	'warning'."""
	root = Path(depository) / 'exhibitions'
	out = []
	if not root.is_dir():
		return out
	for folder in root.iterdir():
		if not folder.is_dir() or folder.name.startswith(('.', '_')):
			continue
		item = {'id': folder.name, 'name': folder.name,
		        'artworkDir': str(folder / 'artwork'), 'warning': None}
		try:
			with open(folder / 'exhibition.json', encoding='utf-8') as f:
				data = json.load(f)
			item['name'] = str(data.get('name') or folder.name)
			if data.get('exhibitionId') and data['exhibitionId'] != folder.name:
				item['warning'] = 'exhibitionId %r differs from folder name' % data['exhibitionId']
		except FileNotFoundError:
			item['warning'] = 'no exhibition.json'
		except (OSError, ValueError) as e:
			item['warning'] = 'unreadable exhibition.json: %s' % e
		out.append(item)
	out.sort(key=lambda x: x['name'].lower())
	return out


# ---------------------------------------------------------------------------
# staging
# ---------------------------------------------------------------------------

def default_staging() -> Path:
	return Path.home() / 'Downloads' / 'asset-transfer'


def _size(path: Path) -> int:
	if path.is_file():
		return path.stat().st_size
	total = 0
	for p in path.rglob('*'):
		if p.is_file():
			total += p.stat().st_size
	return total


def describe(path: Path) -> Dict:
	suffix = path.suffix.lower()
	return {'name': path.name, 'path': str(path), 'isDir': path.is_dir(),
	        'bytes': _size(path),
	        'scannable': path.is_dir() or suffix in SCANNABLE,
	        'executable': suffix in EXECUTABLE}


def staged_entries(folder: os.PathLike) -> List[Dict]:
	"""Top-level files and folders in a transfer folder, as entries. Partial
	copies and hidden files are left out."""
	folder = Path(folder)
	if not folder.is_dir():
		return []
	out = []
	for p in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
		if p.name.startswith('.') or p.name.endswith(PARTIAL_SUFFIX):
			continue
		out.append(describe(p))
	return out


def all_staged(staging: os.PathLike) -> List[Dict]:
	"""Entries from every transfer folder under the staging root, each tagged
	with its 'transfer' folder name. Survives a plugin restart: staging on
	disk is the record, not memory."""
	root = Path(staging)
	out = []
	if not root.is_dir():
		return out
	for t in sorted(root.iterdir()):
		if t.is_dir() and not t.name.startswith('.'):
			for e in staged_entries(t):
				e['transfer'] = t.name
				out.append(e)
	return out


def _inside(child: Path, parent: Path) -> bool:
	try:
		child.resolve().relative_to(parent.resolve())
		return True
	except ValueError:
		return False


# ---------------------------------------------------------------------------
# move
# ---------------------------------------------------------------------------

def move_to_artwork(src: os.PathLike, staging: os.PathLike, depository: os.PathLike,
                    exhibition_id: str) -> Path:
	"""Move one staged file or folder into exhibitions/<id>/artwork/.

	Refuses (TransferError) instead of overwriting, and refuses anything not
	inside the staging root or an exhibition that does not exist. Same-drive
	moves are an atomic rename. A cross-drive move copies to a hidden
	'.<name>.partial' beside the destination first and renames it into place,
	so the artwork scan never sees a half-written file. Returns the
	destination path."""
	src = Path(src)
	staging = Path(staging)
	if not src.exists():
		raise TransferError('%s is no longer in staging' % src.name)
	if not _inside(src, staging):
		raise TransferError('%s is outside the staging folder' % src)
	if not exhibition_id or '/' in exhibition_id or '\\' in exhibition_id or exhibition_id in ('.', '..'):
		raise TransferError('invalid exhibition id %r' % exhibition_id)
	exhibition_dir = Path(depository) / 'exhibitions' / exhibition_id
	if not exhibition_dir.is_dir():
		raise TransferError('exhibition %s does not exist' % exhibition_id)

	artwork = exhibition_dir / 'artwork'
	artwork.mkdir(exist_ok=True)
	dest = artwork / src.name
	if dest.exists():
		raise TransferError('%s already exists in %s/artwork -- rename or remove it first'
		                    % (src.name, exhibition_id))

	try:
		os.rename(src, dest)  # same drive: atomic, no copy
		return dest
	except OSError:
		pass  # cross-drive (EXDEV / WinError 17) -- copy then rename

	partial = artwork / ('.%s%s' % (src.name, PARTIAL_SUFFIX))
	if partial.exists():
		_remove(partial)
	try:
		if src.is_dir():
			shutil.copytree(src, partial)
		else:
			shutil.copy2(src, partial)
		if dest.exists():  # appeared while copying
			raise TransferError('%s appeared in %s/artwork during the copy' % (src.name, exhibition_id))
		os.replace(partial, dest)
	except BaseException:
		if partial.exists():
			_remove(partial)
		raise
	_remove(src)
	return dest


def discard(src: os.PathLike, staging: os.PathLike) -> None:
	"""Delete one staged entry. Refuses anything outside the staging root."""
	src = Path(src)
	if not _inside(src, Path(staging)) or src.resolve() == Path(staging).resolve():
		raise TransferError('%s is outside the staging folder' % src)
	_remove(src)


def prune_empty_transfers(staging: os.PathLike) -> None:
	root = Path(staging)
	if not root.is_dir():
		return
	for t in root.iterdir():
		if t.is_dir():
			try:
				t.rmdir()  # only succeeds when empty
			except OSError:
				pass


def _remove(path: Path) -> None:
	if path.is_dir():
		shutil.rmtree(path)
	elif path.exists():
		path.unlink()


# ---------------------------------------------------------------------------
# croc
# ---------------------------------------------------------------------------

def parse_progress(line: str) -> Optional[int]:
	"""Last percentage in a croc progress line, or None."""
	found = _PERCENT.findall(line)
	if not found:
		return None
	value = int(found[-1])
	return value if 0 <= value <= 100 else None


def build_croc_command(croc: Sequence[str], out_dir: os.PathLike,
                       relay: str = '', relay_pass: str = '') -> List[str]:
	"""argv for a receive. The code phrase is NOT here -- it travels in the
	CROC_SECRET environment variable so it never shows in a process list."""
	cmd = list(croc) + ['--yes', '--overwrite', '--out', str(out_dir)]
	if relay:
		cmd += ['--relay', relay]
	if relay_pass:
		cmd += ['--pass', relay_pass]
	return cmd


def new_transfer_id() -> str:
	return time.strftime('%Y%m%d-%H%M%S') + '-%03d' % (int(time.time() * 1000) % 1000)


class ReceiveWorker(threading.Thread):
	"""One croc receive. Pure Python; never touches TouchDesigner.

	Everything it needs (paths, code, relay) is resolved on the main thread
	and passed in. Results go out through `events` only."""

	def __init__(self, transfer_id: str, code: str, croc: Sequence[str],
	             staging: os.PathLike, events: 'queue.Queue',
	             relay: str = '', relay_pass: str = ''):
		super().__init__(name='croc-receive-%s' % transfer_id, daemon=True)
		self.transfer_id = transfer_id
		self.code = code.strip()
		self.croc = list(croc)
		self.out_dir = Path(staging) / transfer_id
		self.events = events
		self.relay = relay
		self.relay_pass = relay_pass
		self._proc = None
		self._cancel = threading.Event()
		self._log: List[str] = []

	def cancel(self) -> None:
		self._cancel.set()
		proc = self._proc
		if proc is not None and proc.poll() is None:
			try:
				proc.terminate()
			except OSError:
				pass

	def _scrub(self, text: str) -> str:
		if self.code:
			text = text.replace(self.code, '<code>')
		if self.relay_pass:
			text = text.replace(self.relay_pass, '<pass>')
		return text

	def _emit_line(self, raw: str) -> None:
		line = self._scrub(raw.strip())
		if not line:
			return
		pct = parse_progress(line)
		if pct is None or not self._log or parse_progress(self._log[-1]) is None:
			self._log.append(line)
		else:
			self._log[-1] = line  # keep one progress line, not thousands
		del self._log[:-LOG_TAIL]
		self.events.put(('progress', self.transfer_id, {'percent': pct, 'line': line}))

	def run(self) -> None:
		result = {'ok': False, 'cancelled': False, 'returncode': None,
		          'entries': [], 'error': None, 'log': self._log}
		try:
			if not self.code:
				raise TransferError('no code phrase')
			self.out_dir.mkdir(parents=True, exist_ok=False)
			env = dict(os.environ)
			env['CROC_SECRET'] = self.code
			kwargs = {}
			if sys.platform == 'win32':
				kwargs['creationflags'] = 0x08000000  # CREATE_NO_WINDOW
			self._proc = subprocess.Popen(
				build_croc_command(self.croc, self.out_dir, self.relay, self.relay_pass),
				stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
				stderr=subprocess.STDOUT, env=env, cwd=str(self.out_dir), **kwargs)
			if self._cancel.is_set():  # cancelled while starting
				self._proc.terminate()

			# croc redraws its progress bar with \r, so split on both \r and \n.
			buf = b''
			stream = self._proc.stdout
			while True:
				chunk = stream.read1(4096) if hasattr(stream, 'read1') else stream.read(1)
				if not chunk:
					break
				buf += chunk
				parts = re.split(rb'[\r\n]', buf)
				buf = parts.pop()
				for part in parts:
					self._emit_line(part.decode('utf-8', 'replace'))
			if buf:
				self._emit_line(buf.decode('utf-8', 'replace'))

			result['returncode'] = self._proc.wait()
			result['cancelled'] = self._cancel.is_set()
			result['entries'] = staged_entries(self.out_dir)
			if result['cancelled']:
				result['error'] = 'cancelled'
			elif result['returncode'] != 0:
				tail = self._log[-1] if self._log else 'no output'
				result['error'] = 'croc exited with %s: %s' % (result['returncode'], tail)
			elif not result['entries']:
				result['error'] = 'croc finished but received no files'
			else:
				result['ok'] = True
		except FileNotFoundError as e:
			result['error'] = 'croc not found (%s) -- set the Croc path parameter' % e.filename
		except FileExistsError:
			result['error'] = 'transfer folder %s already exists' % self.out_dir
		except TransferError as e:
			result['error'] = str(e)
		except Exception as e:  # report, never kill the thread silently
			result['error'] = self._scrub('%s: %s' % (type(e).__name__, e))
		finally:
			if self._proc is not None and self._proc.stdout is not None:
				self._proc.stdout.close()
			self.events.put(('done', self.transfer_id, result))


class MoveWorker(threading.Thread):
	"""Runs move_to_artwork off the main thread (a cross-drive move is a full
	copy of possibly many GB)."""

	def __init__(self, job_id: str, src, staging, depository, exhibition_id,
	             events: 'queue.Queue'):
		super().__init__(name='asset-move-%s' % job_id, daemon=True)
		self.job_id = job_id
		self.args = (src, staging, depository, exhibition_id)
		self.events = events

	def run(self) -> None:
		try:
			dest = move_to_artwork(*self.args)
			prune_empty_transfers(self.args[1])
			self.events.put(('moved', self.job_id, {'ok': True, 'dest': str(dest), 'error': None}))
		except TransferError as e:
			self.events.put(('moved', self.job_id, {'ok': False, 'dest': None, 'error': str(e)}))
		except Exception as e:
			self.events.put(('moved', self.job_id, {'ok': False, 'dest': None,
			                                        'error': '%s: %s' % (type(e).__name__, e)}))
