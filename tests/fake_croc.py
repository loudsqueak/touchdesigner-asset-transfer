"""Stand-in for croc in tests. Behaviour is chosen by the code phrase it gets
through CROC_SECRET, so a test exercises the same env-var path as the real
thing:

  ok-<name>   writes <name> into --out, draws a \\r progress bar, exits 0
  fail        prints an error, exits 1
  empty       exits 0 having received nothing
  hang        waits until killed (for cancel)
  argv        fails if the code phrase appears anywhere in argv
"""
import os
import sys
import time

argv = sys.argv[1:]
secret = os.environ.get('CROC_SECRET', '')
if secret and any(secret in a for a in argv):
	print('code leaked into argv', flush=True)
	sys.exit(3)
out = argv[argv.index('--out') + 1]

if secret.startswith('ok-'):
	name = secret[3:]
	for pct in (0, 25, 50, 75, 100):
		sys.stdout.write('\r%s  %d%% |####| (%d/4 MB, 9 MB/s)' % (name, pct, pct // 25))
		sys.stdout.flush()
	sys.stdout.write('\n')
	with open(os.path.join(out, name), 'wb') as f:
		f.write(b'x' * 1024)
	sys.exit(0)
if secret == 'fail':
	print('room not ready', flush=True)
	sys.exit(1)
if secret == 'empty':
	sys.exit(0)
if secret == 'hang':
	print('connecting...', flush=True)
	time.sleep(60)
	sys.exit(0)
print('unknown test code', flush=True)
sys.exit(2)
