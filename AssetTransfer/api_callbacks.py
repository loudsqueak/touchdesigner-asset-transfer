"""HTTP front door for the send CLI (cli/ in this repo).

Every route except /api/health needs the token, sent as
"Authorization: Bearer <token>". The token is shown in the plugin's panel.
All work happens in AssetTransferExt on worker threads, so each request
returns immediately.

  GET  /api/health             {"ok": true, "service": "asset-transfer"}
  GET  /api/exhibitions        {"ok": true, "exhibitions": [{"id", "name", "warning"}]}
  POST /api/deliveries         {"code", "exhibition", "plan": {"items": {name: "artwork"|"plugin"},
                                                               "unzip": [zip names]}}
                               -> 202 {"ok": true, "delivery": {...}}
  GET  /api/deliveries/<id>    {"ok": true, "delivery": {"state": receiving|delivering|done|failed,
                                                         "percent", "line", "results", "error"}}
"""
import json
from typing import Any, Dict, Optional

REASONS = {200: 'OK', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized',
           404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
           503: 'Service Unavailable'}


def respond(response: Dict[str, Any], body: Dict[str, Any], status: int = 200) -> Dict[str, Any]:
	response['statusCode'] = status
	response['statusReason'] = REASONS.get(status, 'Unknown')
	response['content-type'] = 'application/json'
	response['data'] = json.dumps(body)
	return response


def fail(response: Dict[str, Any], message: str, status: int = 400) -> Dict[str, Any]:
	return respond(response, {'ok': False, 'error': message}, status)


def header(request: Dict[str, Any], name: str) -> Optional[str]:
	"""A request header, matched case-insensitively wherever TD puts it."""
	want = name.lower()
	for source in (request, request.get('headers') or {}):
		if isinstance(source, dict):
			for k, v in source.items():
				if isinstance(k, str) and k.lower() == want:
					return str(v)
	return None


def bearer(request: Dict[str, Any]) -> Optional[str]:
	value = header(request, 'Authorization') or ''
	return value[7:].strip() if value.lower().startswith('bearer ') else None


def parseBody(request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
	raw = request.get('data', b'')
	if not raw:
		return {}
	try:
		if isinstance(raw, bytes):
			raw = raw.decode('utf-8')
		body = json.loads(raw)
		return body if isinstance(body, dict) else None
	except ValueError:
		return None


def onHTTPRequest(dat, request: Dict[str, Any], response: Dict[str, Any]) -> Dict[str, Any]:
	method = str(request.get('method', '')).upper()
	path = str(request.get('uri', '')).split('?')[0].rstrip('/') or '/'
	parts = path.strip('/').split('/')

	if path == '/api/health':
		return respond(response, {'ok': True, 'service': 'asset-transfer'})

	comp = parent.AssetTransfer
	if comp is None or not comp.extensionsReady:
		return fail(response, 'plugin is starting, try again in a moment', 503)
	ext = comp.ext.AssetTransfer
	transfer = mod('transfer')
	if not transfer.token_matches(bearer(request), ext.ApiToken):
		return fail(response, 'missing or wrong token (see the Asset Transfer panel on Control)', 401)

	try:
		if path == '/api/exhibitions':
			if method != 'GET':
				return fail(response, 'use GET', 405)
			ext.RefreshExhibitions()
			return respond(response, {'ok': True, 'exhibitions': [
				{'id': e['id'], 'name': e['name'], 'warning': e['warning']} for e in ext.Exhibitions]})

		if path == '/api/deliveries':
			if method != 'POST':
				return fail(response, 'use POST', 405)
			body = parseBody(request)
			if body is None:
				return fail(response, 'body must be a JSON object')
			code = str(body.get('code') or '').strip()
			if len(code) < 6:
				return fail(response, 'code must be at least 6 characters')
			try:
				delivery = ext.StartDelivery(code, str(body.get('exhibition') or ''), body.get('plan'))
			except ValueError as e:
				return fail(response, str(e))
			return respond(response, {'ok': True, 'delivery': delivery}, 202)

		if len(parts) == 3 and parts[:2] == ['api', 'deliveries']:
			if method != 'GET':
				return fail(response, 'use GET', 405)
			delivery = ext.DeliveryStatus(parts[2])
			if delivery is None:
				return fail(response, 'no delivery %s' % parts[2], 404)
			return respond(response, {'ok': True, 'delivery': delivery})
	except Exception as e:  # never leave the client hanging without a reason
		debug('api error: %s: %s' % (type(e).__name__, e))
		return fail(response, '%s: %s' % (type(e).__name__, e), 500)

	return fail(response, 'no route %s %s' % (method, path), 404)


def onWebSocketOpen(dat, client, uri):
	return


def onWebSocketClose(dat, client):
	return


def onWebSocketReceiveText(dat, client, data):
	return


def onWebSocketReceiveBinary(dat, client, contents):
	return


def onWebSocketReceivePing(dat, client, contents):
	dat.webSocketSendPong(client, contents)
	return


def onWebSocketReceivePong(dat, client, contents):
	return


def onServerStart(dat):
	return


def onServerStop(dat):
	return
