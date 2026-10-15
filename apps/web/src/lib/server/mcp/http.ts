function rpcError(status: number, code: number, message: string): Response {
	return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

// A request without Origin is not from a browser and proceeds on its Bearer token alone.
export function refuseForeignOrigin(request: Request, selfOrigin: string): Response | null {
	const origin = request.headers.get('origin');
	if (origin === null || origin === selfOrigin) return null;
	return rpcError(403, -32000, `Forbidden: Origin ${origin} is not ${selfOrigin}`);
}

function status(error: unknown): number | undefined {
	if (error === null || typeof error !== 'object' || !('status' in error)) return undefined;
	return typeof error.status === 'number' ? error.status : undefined;
}

// adapter-node fails the read with status 413 past BODY_SIZE_LIMIT: answer that as too large,
// never as a parse error.
export async function readMessage(request: Request): Promise<{ message: unknown } | Response> {
	let text: string;
	try {
		text = await request.text();
	} catch (error) {
		if (status(error) !== 413) throw error;
		return rpcError(413, -32600, 'Request body too large: it exceeds BODY_SIZE_LIMIT');
	}
	let message: unknown;
	try {
		message = JSON.parse(text);
	} catch {
		return rpcError(400, -32700, 'Parse error: the body is not JSON');
	}
	if (Array.isArray(message)) {
		return rpcError(
			400,
			-32600,
			'Invalid Request: JSON-RPC batches are not supported; send one message per request'
		);
	}
	return { message };
}
