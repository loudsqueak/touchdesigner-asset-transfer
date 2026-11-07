"""Asset Transfer control panel.

Build() lays out a FIXED pool of widgets once (code row, transfer rows, staged
rows, log lines). Paint() only rewrites text, colour and visibility, so it is
cheap enough to run on every state change -- AssetTransferExt calls it via
op('ui').Paint(). Nothing is created or destroyed while painting.

All state lives on the AssetTransfer COMP's extension; this panel only reads
it and calls its public actions. Per-row exhibition choices are kept here in
storage (keyed by staged path), because they are a UI selection, not a fact
about the file.
"""

from __future__ import annotations

import time
from typing import Dict, List, Optional

BG          = (0.10, 0.11, 0.13)
AMBER       = (1.00, 0.78, 0.45)
GREY        = (0.55, 0.58, 0.62)
DIM         = (0.35, 0.37, 0.40)
WHITE       = (0.86, 0.86, 0.86)
RED         = (0.90, 0.40, 0.40)
WARN        = (1.00, 0.85, 0.35)
OK_GREEN    = (0.55, 0.85, 0.60)
BTN_GREEN   = (0.25, 0.45, 0.30)
BTN_RED     = (0.50, 0.25, 0.25)
BTN_BLUE    = (0.22, 0.38, 0.55)
BTN_NEUTRAL = (0.22, 0.24, 0.28)
FIELD_BG    = (0.16, 0.17, 0.20)
FONT        = 'Courier New'

UI_W = 1000
PAD = 18
CODE_H = 44
HDR_H = 22
TR_H = 22
ST_H = 28
ST_GAP = 4
LOG_LINE_H = 18
SECTION_GAP = 14
N_TRANSFERS = 4
N_STAGED = 10
N_LOG = 8
DISCARD_ARM_SECONDS = 4.0

H = (PAD + CODE_H + SECTION_GAP
     + HDR_H + N_TRANSFERS * TR_H + SECTION_GAP
     + HDR_H + N_STAGED * (ST_H + ST_GAP) + TR_H + SECTION_GAP
     + HDR_H + N_LOG * LOG_LINE_H + PAD)

# staged-row columns: (key, x, w)
ST_COLS = (('name', PAD, 300), ('size', 322, 80), ('flags', 406, 180))
BTN_EXH_X, BTN_EXH_W = 590, 230
BTN_MOVE_X, BTN_MOVE_W = 826, 70
BTN_DISCARD_X, BTN_DISCARD_W = 902, 80

LEVEL_COLOR = {'info': WHITE, 'warn': WARN, 'error': RED}
STATE_COLOR = {'receiving': AMBER, 'cancelling': WARN, 'received': OK_GREEN,
               'failed': RED, 'cancelled': GREY}

BUTTON_EXEC = """# Routes every btn_* in this panel to the Ui extension.
def onOffToOn(panelValue):
\tparent().ext.Ui.onButton(panelValue.owner.name)
"""

CHOICES_KEY = 'exhibitionChoices'


def _formatBytes(n: int) -> str:
	for unit in ('B', 'KB', 'MB', 'GB'):
		if n < 1024 or unit == 'GB':
			return ('%d %s' % (n, unit)) if unit == 'B' else ('%.1f %s' % (n, unit))
		n /= 1024.0
	return '%d B' % n


def _clip(text: str, n: int) -> str:
	return text if len(text) <= n else text[:n - 1] + '…'


class UiExt:

	def __init__(self, ownerComp: COMP) -> None:
		self.ownerComp = ownerComp
		self._rowPaths: List[Optional[str]] = [None] * N_STAGED
		self._armedDiscard: Optional[str] = None
		self._armedAt = 0.0

	def onInitTD(self) -> None:
		run('args[0].Paint()', self, delayFrames=2)

	def onDestroyTD(self) -> None:
		pass

	# ---- public -----------------------------------------------------------------

	def Build(self) -> None:
		"""Destroy and rebuild every generated widget. Idempotent."""
		ui = self.ownerComp
		for child in list(ui.children):
			if child.name != 'UiExt':
				child.destroy()
		ui.par.w, ui.par.h = UI_W, H
		ui.par.bgcolorr, ui.par.bgcolorg, ui.par.bgcolorb = BG
		ui.par.bgalpha = 1
		ui.par.align = 'none'

		def y(top: int, h: int) -> int:   # top-anchored row -> TD's bottom-up y
			return H - top - h

		top = PAD
		self._text('lbl_code', PAD, y(top, CODE_H), 70, CODE_H, 15, AMBER, 'CODE')
		field = ui.create(textCOMP, 'code_field')
		field.par.x, field.par.y, field.par.w, field.par.h = 92, y(top, CODE_H) + 4, 400, CODE_H - 8
		field.par.editmode = 'editable'
		field.par.type = 'string'
		field.par.font = FONT
		field.par.fontsize = 18
		field.par.fontsizeunits = 'pixels' if 'pixels' in field.par.fontsizeunits.menuNames else field.par.fontsizeunits.eval()
		field.par.bgcolorr, field.par.bgcolorg, field.par.bgcolorb = FIELD_BG
		field.par.bgalpha = 1
		field.par.text.bindExpr = 'parent.AssetTransfer.par.Code'
		field.par.text.mode = ParMode.BIND
		for name, label, x, w, rgb in (
			('btn_receive', 'RECEIVE', 500, 110, BTN_GREEN),
			('btn_cancel', 'CANCEL', 618, 100, BTN_RED),
			('btn_refresh', 'REFRESH', 726, 110, BTN_BLUE),
			('btn_staging', 'OPEN STAGING', 844, UI_W - PAD - 844, BTN_NEUTRAL),
		):
			self._button(name, label, x, y(top, CODE_H), w, CODE_H, rgb, 14)
		top += CODE_H + SECTION_GAP

		self._text('hdr_transfers', PAD, y(top, HDR_H), UI_W - 2 * PAD, HDR_H, 13, GREY, 'TRANSFERS')
		top += HDR_H
		for i in range(N_TRANSFERS):
			self._text('tr_%d' % i, PAD, y(top, TR_H), UI_W - 2 * PAD, TR_H, 13, WHITE)
			top += TR_H
		top += SECTION_GAP

		self._text('hdr_staged', PAD, y(top, HDR_H), UI_W - 2 * PAD, HDR_H, 13, GREY,
		           'STAGED  (name / size / flags / exhibition)')
		top += HDR_H
		for i in range(N_STAGED):
			for key, x, w in ST_COLS:
				self._text('st_%s_%d' % (key, i), x, y(top, ST_H), w, ST_H, 13, WHITE)
			self._button('btn_exh_%d' % i, '', BTN_EXH_X, y(top, ST_H), BTN_EXH_W, ST_H, BTN_NEUTRAL, 12)
			self._button('btn_move_%d' % i, 'MOVE', BTN_MOVE_X, y(top, ST_H), BTN_MOVE_W, ST_H, BTN_GREEN, 12)
			self._button('btn_discard_%d' % i, 'DISCARD', BTN_DISCARD_X, y(top, ST_H), BTN_DISCARD_W, ST_H, BTN_RED, 12)
			top += ST_H + ST_GAP
		self._text('st_more', PAD, y(top, TR_H), UI_W - 2 * PAD, TR_H, 12, DIM)
		top += TR_H + SECTION_GAP

		self._text('hdr_log', PAD, y(top, HDR_H), UI_W - 2 * PAD, HDR_H, 13, GREY, 'LOG')
		top += HDR_H
		for i in range(N_LOG):
			self._text('log_%d' % i, PAD, y(top, LOG_LINE_H), UI_W - 2 * PAD, LOG_LINE_H, 12, WHITE)
			top += LOG_LINE_H

		d = ui.create(panelexecuteDAT, 'panelexec_buttons')
		d.par.panels = 'btn_*'
		d.par.panelvalue = 'state'
		d.par.offtoon = True
		d.par.valuechange = False
		d.text = BUTTON_EXEC

		groups = ('lbl_', 'code_', 'btn_receive', 'btn_cancel', 'btn_refresh', 'btn_staging',
		          'hdr_', 'tr_', 'st_', 'btn_exh', 'btn_move', 'btn_discard', 'log_', 'panelexec_')
		kids = sorted((c for c in ui.children if c.name != 'UiExt'),
		              key=lambda c: (next((i for i, g in enumerate(groups) if c.name.startswith(g)), 99), c.name))
		for i, child in enumerate(kids):
			child.nodeX, child.nodeY = (i % 12) * 200, -(i // 12) * 200
		ext = ui.op('UiExt')
		if ext is not None:
			ext.nodeX, ext.nodeY = -400, 0
		self.Paint()

	def Paint(self) -> None:
		"""Redraw every readout from the AssetTransfer extension's state."""
		ui = self.ownerComp
		if ui.op('log_0') is None:          # not built yet
			return
		host = ui.parent.AssetTransfer
		if host is None or not host.extensionsReady:
			return
		ext = host.ext.AssetTransfer
		self._paintTransfers(ext.Transfers)
		self._paintStaged(ext.Staged, ext.Exhibitions, ext.Moves)
		self._paintLog(ext.Messages)

	# ---- wiring (panelexec_buttons) ---------------------------------------------

	def onButton(self, name: str) -> None:
		host = self.ownerComp.parent.AssetTransfer
		if name == 'btn_receive':
			host.Receive()
		elif name == 'btn_cancel':
			host.Cancel()
		elif name == 'btn_refresh':
			host.RefreshAll()
		elif name == 'btn_staging':
			host.OpenStaging()
		elif name.startswith(('btn_exh_', 'btn_move_', 'btn_discard_')):
			kind, idx = name[4:].rsplit('_', 1)
			path = self._rowPaths[int(idx)]
			if path is None:
				return
			if kind == 'exh':
				self._openExhibitionMenu(self.ownerComp.op(name), path)
			elif kind == 'move':
				host.Move(path, self._choices().get(path))
			elif kind == 'discard':
				if self._armedDiscard == path and time.time() - self._armedAt < DISCARD_ARM_SECONDS:
					self._armedDiscard = None
					host.Discard(path)
				else:
					self._armedDiscard, self._armedAt = path, time.time()
					run('args[0].Paint()', self, delayMilliSeconds=int(DISCARD_ARM_SECONDS * 1000) + 50)
				self.Paint()
		else:
			debug('Ui: no handler for button %s' % name)

	# ---- painting -----------------------------------------------------------------

	def _paintTransfers(self, transfers: Dict[str, Dict]) -> None:
		ui = self.ownerComp
		rows = sorted(transfers.items(), key=lambda kv: kv[1].get('started') or 0, reverse=True)
		for i in range(N_TRANSFERS):
			cell = ui.op('tr_%d' % i)
			if i < len(rows):
				tid, t = rows[i]
				state = t.get('state') or '?'
				pct = '' if t.get('percent') is None else '%3d%%' % t['percent']
				line = t.get('error') or t.get('line') or ''
				self._setText(cell, _clip('%-10s %-11s %5s  %s' % (tid, state, pct, line), 118),
				              STATE_COLOR.get(state, WHITE))
			else:
				self._setText(cell, '(no transfers yet)' if i == 0 else '', DIM)

	def _paintStaged(self, staged: List[Dict], exhibitions: List[Dict], moves: Dict[str, Dict]) -> None:
		ui = self.ownerComp
		names = {e['id']: e['name'] for e in exhibitions}
		choices = self._choices()
		moving = {m['src'] for m in moves.values() if m.get('state') == 'moving'}
		live = {e['path'] for e in staged}
		stale = [p for p in choices if p not in live]
		if stale:
			for p in stale:
				choices.pop(p, None)
			ui.store(CHOICES_KEY, choices)
		for i in range(N_STAGED):
			e = staged[i] if i < len(staged) else None
			self._rowPaths[i] = e['path'] if e else None
			widgets = [ui.op('st_%s_%d' % (k, i)) for k, _, _ in ST_COLS] + \
			          [ui.op('btn_exh_%d' % i), ui.op('btn_move_%d' % i), ui.op('btn_discard_%d' % i)]
			for w in widgets:
				if w is not None and w.par.display.eval() != bool(e):
					w.par.display = bool(e)
			if e is None:
				continue
			self._setText(ui.op('st_name_%d' % i), _clip(e['name'] + ('/' if e['isDir'] else ''), 36), WHITE)
			self._setText(ui.op('st_size_%d' % i), _formatBytes(e['bytes']), GREY)
			if e['executable']:
				flags, rgb = '.tox: RUNS CODE', RED
			elif not e['scannable']:
				flags, rgb = 'not scannable', WARN
			else:
				flags, rgb = 'ok', OK_GREEN
			self._setText(ui.op('st_flags_%d' % i), flags, rgb)
			chosen = choices.get(e['path'])
			self._setLabel(ui.op('btn_exh_%d' % i),
			               _clip(names.get(chosen, chosen), 24) + ' ▾' if chosen else 'choose exhibition ▾')
			self._setLabel(ui.op('btn_move_%d' % i), 'MOVING' if e['path'] in moving else 'MOVE')
			armed = self._armedDiscard == e['path'] and time.time() - self._armedAt < DISCARD_ARM_SECONDS
			self._setLabel(ui.op('btn_discard_%d' % i), 'CONFIRM?' if armed else 'DISCARD')
		extra = len(staged) - N_STAGED
		self._setText(ui.op('st_more'),
		              ('+%d more staged -- open the staging folder to see them' % extra) if extra > 0
		              else ('' if staged else '(nothing staged)'), DIM)

	def _paintLog(self, messages: List) -> None:
		ui = self.ownerComp
		tail = messages[-N_LOG:]
		for i in range(N_LOG):
			if i < len(tail):
				stamp, level, text = tail[i]
				self._setText(ui.op('log_%d' % i), _clip('%s  %s' % (stamp, text), 120), LEVEL_COLOR.get(level, WHITE))
			else:
				self._setText(ui.op('log_%d' % i), '', DIM)

	# ---- exhibition dropdown ------------------------------------------------------

	def _openExhibitionMenu(self, button: Optional[COMP], path: str) -> None:
		host = self.ownerComp.parent.AssetTransfer
		exhibitions = host.ext.AssetTransfer.Exhibitions
		menu = op.TDResources.PopMenu
		if button is not None:
			menu.SetPlacement(buttonComp=button, hAttach='Left', vAttach='Bottom', matchWidth=True)
		if not exhibitions:
			menu.Open(items=['(no exhibitions found -- check Depository folder)'],
			          disabledItems=['(no exhibitions found -- check Depository folder)'])
			host.RefreshExhibitions()
			return
		items = ['%s  (%s)' % (e['name'], e['id']) for e in exhibitions]
		menu.Open(items=items, callback=self._onExhibitionChosen,
		          callbackDetails={'path': path, 'ids': [e['id'] for e in exhibitions]})

	def _onExhibitionChosen(self, info: Dict) -> None:
		details = info.get('details') or {}
		idx = info.get('index')
		ids = details.get('ids') or []
		if idx is None or not (0 <= idx < len(ids)):
			return
		choices = self._choices()
		choices[details['path']] = ids[idx]
		self.ownerComp.store(CHOICES_KEY, choices)
		self.Paint()

	# ---- helpers ------------------------------------------------------------------

	def _choices(self) -> Dict[str, str]:
		return dict(self.ownerComp.fetch(CHOICES_KEY, {}, search=False))

	def _text(self, name: str, x: int, y: int, w: int, h: int, size: int, rgb, text: str = '') -> COMP:
		"""A readout cell: a transparent container whose background is a Text TOP
		(left-aligned, unlike the Text COMP widget)."""
		cell = self.ownerComp.create(containerCOMP, name)
		cell.par.x, cell.par.y, cell.par.w, cell.par.h = x, y, w, h
		cell.par.bgalpha = 0
		cell.par.top = './txt'
		t = cell.create(textTOP, 'txt')
		t.par.outputresolution = 'custom'
		t.par.resolutionw, t.par.resolutionh = w, h
		t.par.font = FONT
		t.par.fontsizex = size
		t.par.fontsizexunit = 'pixels'
		t.par.alignx = 'left'
		t.par.aligny = 'center'
		t.par.positionx = 4
		t.par.bgalpha = 0
		t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = rgb
		t.par.text = text
		return cell

	def _button(self, name: str, label: str, x: int, y: int, w: int, h: int, rgb, fontsize: int) -> COMP:
		b = self.ownerComp.create(buttonCOMP, name)
		if b.name != name:
			b.name = name      # TD appends a digit to new widget names; routing needs the exact name
		b.par.x, b.par.y, b.par.w, b.par.h = x, y, w, h
		b.par.label = label
		b.par.buttontype = 'momentary'
		b.par.fontsize = fontsize
		b.par.bgcolorr, b.par.bgcolorg, b.par.bgcolorb = rgb
		b.par.bgalpha = 1
		b.par.colorr, b.par.colorg, b.par.colorb = (0.93, 0.95, 0.97)
		return b

	@staticmethod
	def _setText(cell: Optional[COMP], text: str, rgb=None) -> None:
		if cell is None:
			return
		t = cell.op('txt')
		if t is None:
			return
		if t.par.text.eval() != text:
			t.par.text = text
		if rgb is not None and (t.par.fontcolorr.eval(), t.par.fontcolorg.eval(), t.par.fontcolorb.eval()) != rgb:
			t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = rgb

	@staticmethod
	def _setLabel(button: Optional[COMP], label: str) -> None:
		if button is not None and button.par.label.eval() != label:
			button.par.label = label
