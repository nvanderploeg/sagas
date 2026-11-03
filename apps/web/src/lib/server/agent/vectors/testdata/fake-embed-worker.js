import { parentPort, workerData } from 'node:worker_threads';

const mode = workerData.dir.split('/').pop();
if (mode === 'fail') parentPort.postMessage({ failed: 'boom' });
else if (mode === 'crash') process.exit(3);
else {
	parentPort.on('message', ({ id, text }) => {
		if (text === 'bad') return parentPort.postMessage({ id, error: 'nope' });
		if (text === 'die') return process.exit(4);
		if (text === 'hang') return;
		const vector = Float32Array.of(text.length, workerData.threads);
		parentPort.postMessage({ id, vector }, [vector.buffer]);
	});
	parentPort.postMessage({ ready: true });
}
