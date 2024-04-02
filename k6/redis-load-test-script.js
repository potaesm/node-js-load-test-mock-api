import { Trend, Rate } from 'k6/metrics';
import { check } from 'k6';
import redis from 'k6/x/redis';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

export const RedisLatencyTrend = new Trend('redis_latency', true);
export const RedisErrorRate = new Rate('redis_error');

const REDIS_DATA_EXP_SEC = 10;

const MAX_DURATION_SEC = 1 * 60 + 30;
const MAX_TPS = 5;
const MAX_VUS = 50;

export const options = {
	scenarios: {
		redis_test_scene: {
			executor: 'ramping-arrival-rate',
			preAllocatedVUs: Math.ceil(MAX_VUS * 0.7),
			maxVUs: MAX_VUS,
			startRate: 1,
			timeUnit: '1s',
			gracefulStop: '30s',
			stages: [
				{
					target: MAX_TPS,
					duration: Math.ceil(MAX_DURATION_SEC * 0.125) * 1000
				},
				{
					target: MAX_TPS,
					duration: Math.ceil(MAX_DURATION_SEC * 0.75) * 1000
				},
				{
					target: 0,
					duration: Math.ceil(MAX_DURATION_SEC * 0.125) * 1000
				}
			]
		}
	},
	thresholds: {
		redis_latency: ['p(90)<005', 'p(95)<005'],
		redis_error: [{ threshold: 'rate<0.1', abortOnFail: true, delayAbortEval: '10s' }]
	}
};

const client = new redis.Client({
	socket: {
		host: 'localhost',
		port: 6379
	},
	username: 'default',
	password: 'redispass'
});

export default async function () {
	const uuid = uuidv4(true);
	const key = 'redis_test_' + uuid;
	const start = Date.now();
	await client.set(key, uuid, REDIS_DATA_EXP_SEC);
	const value = await client.get(key);
	const latency = Date.now() - start;
	const valueCheck = check(value, {
		[`is value = ${uuid}`]: (v) => v === uuid
	});
	RedisErrorRate.add(!valueCheck);
	RedisLatencyTrend.add(latency);
}

export function handleSummary(data) {
	return {
		'summary.html': htmlReport(data)
	};
}
