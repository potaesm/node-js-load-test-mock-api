const express = require('express');
const { createClient } = require('redis');
const app = express();
const InternalServerError = require('http-errors')(500);

const redisURL = 'redis://default:redispass@localhost:6379';

const EXPIRY_TIME_SEC = 120;

async function getClient(url = '') {
	try {
		const client = createClient({ url }).on('error', (error) => {
			console.log('Error ' + error);
		});
		await client.connect();
		console.log('Redis connected!');
		return client;
	} catch (error) {
		console.error(error);
	}
}

async function getValue(client = createClient(), key = '') {
	try {
		// console.log(`getValue with key: ${key}`);
		return await client.GET(key);
	} catch (error) {
		console.error(error);
	}
}

async function setKeyValue(client = createClient(), key = '', seconds = 0, value = '') {
	try {
		// console.log(`setKeyValue with key: ${key}, value: ${value}`);
		return await client.SETEX(key, seconds, value);
	} catch (error) {
		console.error(error);
	}
}

async function deleteValues(client = createClient(), pattern = '') {
	try {
		let cursor = 0;
		do {
			const result = await client.scan(cursor, { MATCH: pattern, COUNT: 10000 });
			cursor = result.cursor;
			if (result.keys?.length > 0) {
				// console.log(`deleteValues with keys: ${result.keys}`);
				await client.del(result.keys);
			}
		} while (cursor !== 0);
	} catch (error) {
		console.error(error);
	}
}

(async function () {
	const client = await getClient(redisURL);
	app.use(express.json({ extended: false }));
	app.use(express.urlencoded({ extended: false }));

	app.post('/set', async (req, res) => {
		try {
			const { body = { message: 'Hello World!' } } = req.body;
			const entries = Object.entries(body);
			const resultPromiseList = [];
			for (const [key, value] of entries) {
				resultPromiseList.push(setKeyValue(client, key, EXPIRY_TIME_SEC, value));
			}
			const results = await Promise.all(resultPromiseList);
			return res.send(results || []);
		} catch (error) {
			res.status(InternalServerError.status);
			res.send(InternalServerError);
		}
	});

	app.get('/get', async (req, res) => {
		try {
			const { key = 'message' } = req.query;
			return res.send(await getValue(client, key));
		} catch (error) {
			res.status(InternalServerError.status);
			res.send(InternalServerError);
		}
	});

	app.delete('/delete', async (req, res) => {
		try {
			const { pattern = 'message' } = req.query;
			return res.send(await deleteValues(client, pattern));
		} catch (error) {
			res.status(InternalServerError.status);
			res.send(InternalServerError);
		}
	});

	app.listen(process.env.PORT || 5000, () => {
		console.log('Server is running at 5000');
	}).on('error', (error) => {
		console.error(error);
		client.disconnect();
	});
})();
