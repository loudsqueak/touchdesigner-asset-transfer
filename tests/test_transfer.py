"""Run: python3 -m unittest discover -s tests   (stdlib only, no TD, no croc)"""
import json
import os
import queue
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'AssetTransfer'))

import transfer  # noqa: E402

FAKE = [sys.executable, '-I', str(HERE / 'fake_croc.py')]


def wait_done(events, timeout=20):
	progress = []
	deadline = time.time() + timeout
	while time.time() < deadline:
		try:
			kind, _tid, data = events.get(timeout=0.2)
		except queue.Empty:
			continue
		if kind == 'progress':
			progress.append(data)
		elif kind == 'done':
			return data, progress
	raise AssertionError('worker never reported done')


class Base(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		root = Path(self.tmp.name)
		self.depository = root / 'repo' / 'depository'
		self.staging = root / 'staging'
		self.staging.mkdir()
		self.show = self.depository / 'exhibitions' / 'summer_sJJcK'
		self.show.mkdir(parents=True)
		(self.show / 'exhibition.json').write_text(json.dumps(
			{'exhibitionId': 'summer_sJJcK', 'name': 'Summer Show'}))

	def tearDown(self):
		self.tmp.cleanup()

	def stage(self, transfer_id, name, data=b'abc'):
		d = self.staging / transfer_id
		d.mkdir(exist_ok=True)
		p = d / name
		p.write_bytes(data)
		return p


class TestExhibitions(Base):
	def test_find_depository_walks_up(self):
		deep = self.depository.parent / 'plugins' / 'x'
		deep.mkdir(parents=True)
		self.assertEqual(transfer.find_depository([None, deep]), self.depository.resolve())

	def test_find_depository_none(self):
		self.assertIsNone(transfer.find_depository([self.staging]))

	def test_list_names_and_broken_json(self):
		bad = self.depository / 'exhibitions' / 'broken_abc'
		bad.mkdir()
		(bad / 'exhibition.json').write_text('{nope')
		(self.depository / 'exhibitions' / '_library').mkdir()
		shows = transfer.list_exhibitions(self.depository)
		self.assertEqual([s['id'] for s in shows], ['broken_abc', 'summer_sJJcK'])
		self.assertEqual(shows[1]['name'], 'Summer Show')
		self.assertIn('unreadable', shows[0]['warning'])


class TestMove(Base):
	def test_move_creates_artwork_and_cleans_staging(self):
		src = self.stage('t1', 'clip.mp4')
		dest = transfer.move_to_artwork(src, self.staging, self.depository, 'summer_sJJcK')
		self.assertEqual(dest, self.show / 'artwork' / 'clip.mp4')
		self.assertEqual(dest.read_bytes(), b'abc')
		self.assertFalse(src.exists())

	def test_collision_refused_not_overwritten(self):
		(self.show / 'artwork').mkdir()
		(self.show / 'artwork' / 'clip.mp4').write_bytes(b'original')
		src = self.stage('t1', 'clip.mp4')
		with self.assertRaisesRegex(transfer.TransferError, 'already exists'):
			transfer.move_to_artwork(src, self.staging, self.depository, 'summer_sJJcK')
		self.assertEqual((self.show / 'artwork' / 'clip.mp4').read_bytes(), b'original')
		self.assertTrue(src.exists())

	def test_unknown_and_malicious_exhibitions_refused(self):
		src = self.stage('t1', 'clip.mp4')
		for bad in ('nope', '../summer_sJJcK', '..', ''):
			with self.assertRaises(transfer.TransferError):
				transfer.move_to_artwork(src, self.staging, self.depository, bad)

	def test_source_outside_staging_refused(self):
		outside = self.depository.parent / 'secret.mp4'
		outside.write_bytes(b'x')
		with self.assertRaisesRegex(transfer.TransferError, 'outside'):
			transfer.move_to_artwork(outside, self.staging, self.depository, 'summer_sJJcK')

	def test_cross_drive_copy_path_file_and_folder(self):
		f = self.stage('t1', 'clip.mp4')
		folder = self.staging / 't1' / 'bundle'
		(folder / 'sub').mkdir(parents=True)
		(folder / 'sub' / 'a.py').write_text('x')
		with mock.patch.object(transfer.os, 'rename', side_effect=OSError(18, 'EXDEV')):
			transfer.move_to_artwork(f, self.staging, self.depository, 'summer_sJJcK')
			transfer.move_to_artwork(folder, self.staging, self.depository, 'summer_sJJcK')
		art = self.show / 'artwork'
		self.assertEqual((art / 'clip.mp4').read_bytes(), b'abc')
		self.assertEqual((art / 'bundle' / 'sub' / 'a.py').read_text(), 'x')
		self.assertEqual([p.name for p in art.iterdir() if p.name.endswith('.partial')], [])
		self.assertFalse(f.exists() or folder.exists())

	def test_failed_copy_leaves_no_partial(self):
		src = self.stage('t1', 'clip.mp4')
		with mock.patch.object(transfer.os, 'rename', side_effect=OSError(18, 'EXDEV')), \
		     mock.patch.object(transfer.shutil, 'copy2', side_effect=OSError(28, 'disk full')):
			with self.assertRaises(OSError):
				transfer.move_to_artwork(src, self.staging, self.depository, 'summer_sJJcK')
		self.assertEqual(list((self.show / 'artwork').iterdir()), [])
		self.assertTrue(src.exists())

	def test_staged_listing_and_flags(self):
		self.stage('t1', 'clip.MP4')
		self.stage('t1', 'show.tox')
		self.stage('t1', 'notes.txt')
		self.stage('t1', '.hidden')
		self.stage('t1', 'x.mov.partial')
		entries = {e['name']: e for e in transfer.all_staged(self.staging)}
		self.assertEqual(set(entries), {'clip.MP4', 'show.tox', 'notes.txt'})
		self.assertTrue(entries['clip.MP4']['scannable'])
		self.assertTrue(entries['show.tox']['executable'])
		self.assertFalse(entries['notes.txt']['scannable'])
		self.assertEqual(entries['clip.MP4']['transfer'], 't1')

	def test_discard_guarded(self):
		src = self.stage('t1', 'clip.mp4')
		transfer.discard(src, self.staging)
		self.assertFalse(src.exists())
		with self.assertRaises(transfer.TransferError):
			transfer.discard(self.staging, self.staging)


class TestCroc(Base):
	def run_receive(self, code, **kw):
		events = queue.Queue()
		w = transfer.ReceiveWorker('t1', code, FAKE, self.staging, events, **kw)
		w.start()
		return w, events

	def test_command_keeps_code_out_of_argv(self):
		cmd = transfer.build_croc_command(['croc'], '/out', relay='r:9009', relay_pass='pw')
		self.assertEqual(cmd, ['croc', '--yes', '--overwrite', '--out', '/out',
		                       '--relay', 'r:9009', '--pass', 'pw'])

	def test_parse_progress(self):
		self.assertEqual(transfer.parse_progress('clip.mp4  42% |##  | (1/2 GB)'), 42)
		self.assertIsNone(transfer.parse_progress('connecting...'))

	def test_receive_ok(self):
		_w, events = self.run_receive('ok-clip.mp4')
		done, progress = wait_done(events)
		self.assertTrue(done['ok'], done)
		self.assertEqual([e['name'] for e in done['entries']], ['clip.mp4'])
		self.assertEqual(progress[-1]['percent'], 100)
		self.assertLessEqual(sum(1 for l in done['log'] if '%' in l), 1)  # bar collapsed

	def test_receive_failure_reported(self):
		_w, events = self.run_receive('fail')
		done, _ = wait_done(events)
		self.assertFalse(done['ok'])
		self.assertIn('room not ready', done['error'])

	def test_receive_nothing_is_an_error(self):
		_w, events = self.run_receive('empty')
		done, _ = wait_done(events)
		self.assertFalse(done['ok'])
		self.assertIn('no files', done['error'])

	def test_cancel(self):
		w, events = self.run_receive('hang')
		time.sleep(1.0)
		w.cancel()
		done, _ = wait_done(events)
		self.assertTrue(done['cancelled'])
		self.assertFalse(done['ok'])

	def test_missing_croc(self):
		events = queue.Queue()
		w = transfer.ReceiveWorker('t1', 'ok-x', ['/no/such/croc'], self.staging, events)
		w.start()
		done, _ = wait_done(events)
		self.assertIn('croc not found', done['error'])

	def test_code_and_pass_scrubbed_from_log(self):
		events = queue.Queue()
		w = transfer.ReceiveWorker('t1', 'secret-phrase', FAKE, self.staging, events, relay_pass='pw123')
		w._emit_line('joining secret-phrase with pw123')
		self.assertEqual(w._log[-1], 'joining <code> with <pass>')


if __name__ == '__main__':
	unittest.main()
