# Pumps worker-thread results into the main thread once per frame.
def onFrameStart(frame):
	comp = parent.AssetTransfer
	if comp is not None and comp.extensionsReady and hasattr(comp, 'Tick'):
		comp.Tick()
