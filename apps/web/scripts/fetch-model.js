import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MODEL = 'Xenova/bge-small-en-v1.5';
// Vectors from two revisions don't compare: change this only together with a full re-embed.
const REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
const FILES = [
	'config.json',
	'tokenizer.json',
	'tokenizer_config.json',
	'onnx/model_quantized.onnx'
];

const dir = resolve(process.env.EMBEDDING_MODEL_DIR ?? 'models');

for (const file of FILES) {
	const response = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`);
	if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
	const target = join(dir, MODEL, file);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

console.log(dir);
