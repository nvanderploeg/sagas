import { parentPort, workerData } from 'node:worker_threads';

const { dir, name, threads } = workerData;

try {
	// Importing it loads sharp and onnxruntime natively; only a server with the model pays.
	const { env, pipeline } = await import('@huggingface/transformers');
	env.allowRemoteModels = false;
	env.localModelPath = dir;
	env.useFSCache = false;
	const extractor = await pipeline('feature-extraction', name, {
		dtype: 'q8',
		session_options: { intraOpNumThreads: threads }
	});
	parentPort.on('message', async ({ id, text }) => {
		try {
			// One text per call: batching pads and changes the vectors.
			const output = await extractor([text], { pooling: 'cls', normalize: true });
			const vector = Float32Array.from(output.data);
			parentPort.postMessage({ id, vector }, [vector.buffer]);
		} catch (error) {
			parentPort.postMessage({ id, error: String(error?.message ?? error) });
		}
	});
	parentPort.postMessage({ ready: true });
} catch (error) {
	parentPort.postMessage({ failed: String(error?.stack ?? error) });
}
