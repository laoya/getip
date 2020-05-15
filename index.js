'use strict';
const {promisify} = require('util');
const dgram = require('dgram');
const dns = require('dns-socket');
const http = require('http');
const isIp = require('is-ip');

const defaults = {
	timeout: 5000,
	onlyHttps: false
};

const dnsServers = [
	{
		v4: {
			servers: [
				'114.114.114.114'
			],
			name: 'myip.opendns.com',
			type: 'A'
		},
		v6: {
			servers: [
				'2620:0:ccc::2',
				'2620:0:ccd::2'
			],
			name: 'myip.opendns.com',
			type: 'AAAA'
		}
	}
];

const type = {
	v4: {
		dnsServers: dnsServers.map(({v4: {servers, ...question}}) => ({
			servers, question
		})),
		httpsUrls: [
			'https://icanhazip.com/',
			'https://api.ipify.org/'
		]
	},
	v6: {
		dnsServers: dnsServers.map(({v6: {servers, ...question}}) => ({
			servers, question
		})),
		httpsUrls: [
			'https://icanhazip.com/',
			'https://api6.ipify.org/'
		]
	}
};

const queryDns = (version, options) => {
	const data = type[version];

	const socket = dns({
		retries: 0,
		maxQueries: 1,
		socket: dgram.createSocket(version === 'v6' ? 'udp6' : 'udp4'),
		timeout: options.timeout
	});
	socket.retries = 0; // Temp fix, pull request: https://github.com/mafintosh/dns-socket/pull/22

	const socketQuery = promisify(socket.query.bind(socket));

	const promise = (async () => {
		for (const dnsServerInfo of data.dnsServers) {
			const {servers, question} = dnsServerInfo;
			for (const server of servers) {
				if (socket.destroyed) {
					return;
				}

				try {
					const {name, type, transform} = question;

					// eslint-disable-next-line no-await-in-loop
					const dnsResponse = await socketQuery({questions: [{name, type}]}, 53, server);

					const {
						answers: {
							0: {
								data
							}
						}
					} = dnsResponse;

					const response = (typeof data === 'string' ? data : data.toString()).trim();

					const ip = transform ? transform(response) : response;

					if (ip && isIp[version](ip)) {
						socket.destroy();
						return ip;
					}
				} catch (_) {}
			}
		}

		socket.destroy();

		throw new Error('Couldn\'t find your IP');
	})();

	promise.cancel = () => {
		socket.destroy();
	};

	return promise;
};

const queryHttps = (version, options) => {
	let cancel;

	const promise = (async () => {
		try {
			const requestOptions = {
				family: version === 'v6' ? 6 : 4,
				retries: 0,
				timeout: options.timeout
			};

			const urls = [].concat.apply(type[version].httpsUrls, options.fallbackUrls || []);

			for (const url of urls) {
				try {
					const gotPromise = got(url, requestOptions);
					cancel = gotPromise.cancel;

					// eslint-disable-next-line no-await-in-loop
					const response = await gotPromise;

					const ip = (response.body || '').trim();

					if (ip && isIp[version](ip)) {
						return ip;
					}
				} catch (error) {
					if (error instanceof CancelError) {
						throw error;
					}
				}
			}

			throw new Error('Couldn\'t find your IP');
		} catch (error) {
			// Don't throw a cancellation error for consistency with DNS
			if (!(error instanceof CancelError)) {
				throw error;
			}
		}
	})();

	promise.cancel = function () {
		return cancel.apply(this);
	};

	return promise;
};

const queryAll = (version, options) => {
	let cancel;
	const promise = (async () => {
		let response;
		const dnsPromise = queryDns(version, options);
		cancel = dnsPromise.cancel;
		try {
			response = await dnsPromise;
		} catch (_) {
			const httpsPromise = queryHttps(version, options);
			cancel = httpsPromise.cancel;
			response = await httpsPromise;
		}

		return response;
	})();

	promise.cancel = cancel;

	return promise;
};

module.exports.v4 = options => {
	options = {
		...defaults,
		...options
	};

	if (!options.onlyHttps) {
		return queryAll('v4', options);
	}

	if (options.onlyHttps) {
		return queryHttps('v4', options);
	}

	return queryDns('v4', options);
};

module.exports.v6 = options => {
	options = {
		...defaults,
		...options
	};

	if (!options.onlyHttps) {
		return queryAll('v6', options);
	}

	if (options.onlyHttps) {
		return queryHttps('v6', options);
	}

	return queryDns('v6', options);
};
