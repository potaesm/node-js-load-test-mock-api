import http from 'k6/http';
import redis from 'k6/x/redis';

import { Rate, Trend, Counter } from 'k6/metrics';
import { check, group, sleep } from 'k6';

import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const TEST_HOST_URL = 'http://localhost:5000/set';

const APP_INTERNAL_DELAY_SEC = 0.003;
const TEST_SLEEP_DELAY_SEC = 0.001;

const MAX_ITPS = 5;
const MAX_VUS = 50;
const MAX_DURATION_SEC = 1 * 60 + 30;

const redisClient = new redis.Client({
	socket: {
		host: 'localhost',
		port: 6379
	},
	username: 'default',
	password: 'redispass'
});

const failRate = new Rate('fail_rate');

const serverLatencyTrend = new Trend('server_latency', true);
const internalLatencyTrend = new Trend('internal_latency', true);
const totalLatencyTrend = new Trend('total_latency', true);

const storeDataRequestCounter = new Counter('store_data_request_count');
const dataVerificationCounter = new Counter('data_verification_count');

export function handleSummary(data) {
	return {
		'summary.html': htmlReport(data),
		stdout: textSummary(data, {
			indent: ' ',
			enableColors: true
		})
	};
}

function getScenarioConfig(maxTPS, maxVUs, functionName) {
	return {
		executor: 'ramping-arrival-rate',
		startRate: 1,
		timeUnit: '1s',
		preAllocatedVUs: Math.ceil(maxVUs * 0.7),
		maxVUs: maxVUs,
		gracefulStop: '30s',
		stages: [
			{
				target: maxTPS,
				duration: Math.ceil(MAX_DURATION_SEC * 0.125) * 1000
			},
			{
				target: maxTPS,
				duration: Math.ceil(MAX_DURATION_SEC * 0.75) * 1000
			},
			{
				target: 0,
				duration: Math.ceil(MAX_DURATION_SEC * 0.125) * 1000
			}
		],
		exec: functionName
	};
}

function logging(message, item) {
	console.log(message, item ? JSON.stringify(item) : '');
}

export const options = {
	summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
	noConnectionReuse: false,
	noVUConnectionReuse: false,
	scenarios: {
		save_data_scene: getScenarioConfig(MAX_ITPS, MAX_VUS, 'saveDataSceneHandler')
	},
	thresholds: {
		server_latency: [
			'p(95)<010',
			'p(99)<020',
			{
				threshold: 'max<015',
				abortOnFail: false
			}
		],
		internal_latency: [
			'p(95)<010',
			'p(99)<020',
			{
				threshold: 'max<015',
				abortOnFail: false
			}
		],
		total_latency: [
			'p(95)<010',
			'p(99)<020',
			{
				threshold: 'max<015',
				abortOnFail: false
			}
		],
		fail_rate: [
			{
				threshold: 'rate<=0.05',
				abortOnFail: false
			},
			{
				threshold: 'rate<=0.1',
				abortOnFail: true
			}
		]
	}
};

export function saveDataSceneHandler() {
	const requestParams = {
		headers: {
			'Content-Type': 'application/json'
		}
	};
	const evaluations = {
		errors: [],
		storeData: {
			durationMs: 0,
			hasReceivedRequest: false,
			hasStored: false
		}
	};
	group('save_data_scene', (_) => {
		if (evaluations.errors.length === 0) {
			group('store_data_step', (_) => {
				const randomValue = uuidv4(true);
				const startTimestamp = Date.now();
				storeDataRequestCounter.add(1, {
					name: 'store_data_request'
				});
				const body = JSON.stringify({ [`app_${randomValue}`]: randomValue });
				const response = http.post(
					TEST_HOST_URL,
					body,
					Object.assign({}, requestParams, {
						tags: {
							name: 'store_data_request'
						}
					})
				);
				evaluations.storeData.durationMs = Date.now() - startTimestamp;
				evaluations.storeData.hasReceivedRequest = check(
					response,
					{
						'store data request success': (r) => r.status === 200
					},
					{
						name: 'store_data_request'
					}
				);
				if (evaluations.storeData.hasReceivedRequest) {
					serverLatencyTrend.add(evaluations.storeData.durationMs, {
						name: 'web_server_resonse'
					});
				}
				failRate.add(!evaluations.storeData.hasReceivedRequest, {
					name: 'store_data_request'
				});
				sleep(TEST_SLEEP_DELAY_SEC);
				if (!evaluations.storeData.hasReceivedRequest) {
					console.error(`Data store failed: ${randomValue}`, error);
					evaluations.errors.push('store_data_request');
					evaluations.storeData.hasReceivedRequest = check(
						null,
						{
							'store data request success': (_) => false
						},
						{
							name: 'store_data_request'
						}
					);
					storeDataRequestCounter.add(1, {
						name: 'failed_store_data_request'
					});
				} else {
					group('verify_data_step', (_) => {
						sleep(APP_INTERNAL_DELAY_SEC);
						try {
							redisClient.get(`app_${randomValue}`).then((data) => {
								const { value: storedValue, durationMs: internalDurationMs } = JSON.parse(data);
								evaluations.storeData.hasStored = check(
									storedValue,
									{
										'data verified': (v) => v === randomValue
									},
									{
										name: 'data_verification'
									}
								);
								logging('[save_data_scene_no_cache]', {
									evaluations
								});
								failRate.add(!evaluations.storeData.hasStored, {
									name: 'data_verification'
								});
								if (!evaluations.storeData.hasStored) {
									console.log({ incorrectData: { randomValue, storedValue } });
									evaluations.errors.push('data_verification');
								} else {
									internalLatencyTrend.add(Number(internalDurationMs), {
										name: 'data_verification'
									});
									totalLatencyTrend.add(evaluations.storeData.durationMs + Number(internalDurationMs), {
										name: 'data_verification'
									});
									dataVerificationCounter.add(1, {
										name: 'data_verification'
									});
								}
							});
							sleep(TEST_SLEEP_DELAY_SEC);
						} catch (error) {
							console.error(`Data verification failed: ${randomValue}`, error);
							failRate.add(!evaluations.storeData.hasStored, {
								name: 'data_verification'
							});
							evaluations.errors.push('data_verification');
							evaluations.storeData.hasStored = check(
								null,
								{
									'data verified': (_) => false
								},
								{
									name: 'data_verification'
								}
							);
							dataVerificationCounter.add(1, {
								name: 'failed_data_verification'
							});
						}
					});
				}
			});
		}
	});
}
