# Relays the AssetTransfer COMP's pulse parameters to AssetTransferExt.
def onPulse(par):
	parent.AssetTransfer.OnParPulse(par.name)
