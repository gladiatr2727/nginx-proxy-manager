const _                  = require('lodash');
const fs                 = require('fs');
const tempWrite          = require('temp-write');
const moment             = require('moment');
const logger             = require('../logger').ssl;
const error              = require('../lib/error');
const utils              = require('../lib/utils');
const certificateModel   = require('../models/certificate');
const dnsPlugins         = require('../global/certbot-dns-plugins');
const internalAuditLog   = require('./audit-log');
const internalNginx      = require('./nginx');
const internalHost       = require('./host');
const letsencryptStaging = process.env.NODE_ENV !== 'production';
const letsencryptConfig  = '/etc/letsencrypt.ini';
const certbotCommand     = 'certbot';

function omissions() {
	return ['is_deleted'];
}

const internalCertificate = {

	allowedSslFiles:    ['certificate', 'certificate_key', 'intermediate_certificate'],
	intervalTimeout:    1000 * 60 * 60, // 1 hour
	interval:           null,
	intervalProcessing: false,

	initTimer: () => {
		logger.info('Let\'s Encrypt Renewal Timer initialized');
		internalCertificate.interval = setInterval(internalCertificate.processExpiringHosts, internalCertificate.intervalTimeout);
		// And do this now as well
		internalCertificate.processExpiringHosts();
	},

	/**
	 * Triggered by a timer, this will check for expiring hosts and renew their ssl certs if required
	 */
	processExpiringHosts: () => {
		if (!internalCertificate.intervalProcessing) {
			internalCertificate.intervalProcessing = true;
			logger.info('Renewing SSL certs close to expiry...');

			const cmd = certbotCommand + ' renew --non-interactive --quiet ' +
				'--config "' + letsencryptConfig + '" ' +
				'--preferred-challenges "dns,http" ' +
				'--disable-hook-validation ' +
				(letsencryptStaging ? '--staging' : '');

			return utils.exec(cmd)
				.then((result) => {
					if (result) {
						logger.info('Renew Result: ' + result);
					}

					return internalNginx.reload()
						.then(() => {
							logger.info('Renew Complete');
							return result;
						});
				})
				.then(() => {
					// Now go and fetch all the letsencrypt certs from the db and query the files and update expiry times
					return certificateModel
						.query()
						.where('is_deleted', 0)
						.andWhere('provider', 'letsencrypt')
						.then((certificates) => {
							if (certificates && certificates.length) {
								let promises = [];

								certificates.map(function (certificate) {
									promises.push(
										internalCertificate.getCertificateInfoFromFile('/etc/letsencrypt/live/npm-' + certificate.id + '/fullchain.pem')
											.then((cert_info) => {
												return certificateModel
													.query()
													.where('id', certificate.id)
													.andWhere('provider', 'letsencrypt')
													.patch({
														expires_on: moment(cert_info.dates.to, 'X').format('YYYY-MM-DD HH:mm:ss')
													});
											})
											.catch((err) => {
												// Don't want to stop the train here, just log the error
												logger.error(err.message);
											})
									);
								});

								return Promise.all(promises);
							}
						});
				})
				.then(() => {
					internalCertificate.intervalProcessing = false;
				})
				.catch((err) => {
					logger.error(err);
					internalCertificate.intervalProcessing = false;
				});
		}
	},

	/**
	 * @param   {Access}  access
	 * @param   {Object}  data
	 * @returns {Promise}
	 */
	create: (access, data) => {
		return access.can('certificates:create', data)
			.then(() => {
				data.owner_user_id = access.token.getUserId(1);

				if (data.provider === 'letsencrypt') {
					data.nice_name = data.domain_names.sort().join(', ');
				}

				return certificateModel
					.query()
					.omit(omissions())
					.insertAndFetch(data);
			})
			.then((certificate) => {
				if (certificate.provider === 'letsencrypt') {
					// Request a new Cert from LE. Let the fun begin.

					// 1. Find out any hosts that are using any of the hostnames in this cert
					// 2. Disable them in nginx temporarily
					// 3. Generate the LE config
					// 4. Request cert
					// 5. Remove LE config
					// 6. Re-instate previously disabled hosts

					// 1. Find out any hosts that are using any of the hostnames in this cert
					return internalHost.getHostsWithDomains(certificate.domain_names)
						.then((in_use_result) => {
							// 2. Disable them in nginx temporarily
							return internalCertificate.disableInUseHosts(in_use_result)
								.then(() => {
									return in_use_result;
								});
						})
						.then((in_use_result) => {
							// With DNS challenge no config is needed, so skip 3 and 5.
							if (certificate.meta.dns_challenge) {
								return internalNginx.reload().then(() => {
									// 4. Request cert
									return internalCertificate.requestLetsEncryptSslWithDnsChallenge(certificate);
								})
									.then(internalNginx.reload)
									.then(() => {
										// 6. Re-instate previously disabled hosts
										return internalCertificate.enableInUseHosts(in_use_result);
									})
									.then(() => {
										return certificate;
									})
									.catch((err) => {
										// In the event of failure, revert things and throw err back
										return internalCertificate.enableInUseHosts(in_use_result)
											.then(internalNginx.reload)
											.then(() => {
												throw err;
											});
									});
							} else {
								// 3. Generate the LE config
								return internalNginx.generateLetsEncryptRequestConfig(certificate)
									.then(internalNginx.reload)
									.then(() => {
										// 4. Request cert
										return internalCertificate.requestLetsEncryptSsl(certificate);
									})
									.then(() => {
										// 5. Remove LE config
										return internalNginx.deleteLetsEncryptRequestConfig(certificate);
									})
									.then(internalNginx.reload)
									.then(() => {
										// 6. Re-instate previously disabled hosts
										return internalCertificate.enableInUseHosts(in_use_result);
									})
									.then(() => {
										return certificate;
									})
									.catch((err) => {
										// In the event of failure, revert things and throw err back
										return internalNginx.deleteLetsEncryptRequestConfig(certificate)
											.then(() => {
												return internalCertificate.enableInUseHosts(in_use_result);
											})
											.then(internalNginx.reload)
											.then(() => {
												throw err;
											});
									});
							}
						})
						.then(() => {
							// At this point, the letsencrypt cert should exist on disk.
							// Lets get the expiry date from the file and update the row silently
							return internalCertificate.getCertificateInfoFromFile('/etc/letsencrypt/live/npm-' + certificate.id + '/fullchain.pem')
								.then((cert_info) => {
									return certificateModel
										.query()
										.patchAndFetchById(certificate.id, {
											expires_on: moment(cert_info.dates.to, 'X').format('YYYY-MM-DD HH:mm:ss')
										})
										.then((saved_row) => {
											// Add cert data for audit log
											saved_row.meta = _.assign({}, saved_row.meta, {
												letsencrypt_certificate: cert_info
											});

											return saved_row;
										});
								});
						}).catch(async (error) => {
							// Delete the certificate from the database if it was not created successfully
							await certificateModel
								.query()
								.deleteById(certificate.id);

							throw error;
						});
				} else {
					return certificate;
				}
			}).then((certificate) => {

				data.meta = _.assign({}, data.meta || {}, certificate.meta);

				// Add to audit log
				return internalAuditLog.add(access, {
					action:      'created',
					object_type: 'certificate',
					object_id:   certificate.id,
					meta:        data
				})
					.then(() => {
						return certificate;
					});
			});
	},

	/**
	 * @param  {Access}  access
	 * @param  {Object}  data
	 * @param  {Number}  data.id
	 * @param  {String}  [data.email]
	 * @param  {String}  [data.name]
	 * @return {Promise}
	 */
	update: (access, data) => {
		return access.can('certificates:update', data.id)
			.then((/*access_data*/) => {
				return internalCertificate.get(access, {id: data.id});
			})
			.then((row) => {
				if (row.id !== data.id) {
					// Sanity check that something crazy hasn't happened
					throw new error.InternalValidationError('Certificate could not be updated, IDs do not match: ' + row.id + ' !== ' + data.id);
				}

				return certificateModel
					.query()
					.omit(omissions())
					.patchAndFetchById(row.id, data)
					.then((saved_row) => {
						saved_row.meta = internalCertificate.cleanMeta(saved_row.meta);
						data.meta      = internalCertificate.cleanMeta(data.meta);

						// Add row.nice_name for custom certs
						if (saved_row.provider === 'other') {
							data.nice_name = saved_row.nice_name;
						}

						// Add to audit log
						return internalAuditLog.add(access, {
							action:      'updated',
							object_type: 'certificate',
							object_id:   row.id,
							meta:        _.omit(data, ['expires_on']) // this prevents json circular reference because expires_on might be raw
						})
							.then(() => {
								return _.omit(saved_row, omissions());
							});
					});
			});
	},

	/**
	 * @param  {Access}   access
	 * @param  {Object}   data
	 * @param  {Number}   data.id
	 * @param  {Array}    [data.expand]
	 * @param  {Array}    [data.omit]
	 * @return {Promise}
	 */
	get: (access, data) => {
		if (typeof data === 'undefined') {
			data = {};
		}

		return access.can('certificates:get', data.id)
			.then((access_data) => {
				let query = certificateModel
					.query()
					.where('is_deleted', 0)
					.andWhere('id', data.id)
					.allowEager('[owner]')
					.first();

				if (access_data.permission_visibility !== 'all') {
					query.andWhere('owner_user_id', access.token.getUserId(1));
				}

				// Custom omissions
				if (typeof data.omit !== 'undefined' && data.omit !== null) {
					query.omit(data.omit);
				}

				if (typeof data.expand !== 'undefined' && data.expand !== null) {
					query.eager('[' + data.expand.join(', ') + ']');
				}

				return query;
			})
			.then((row) => {
				if (row) {
					return _.omit(row, omissions());
				} else {
					throw new error.ItemNotFoundError(data.id);
				}
			});
	},

	/**
	 * @param {Access}  access
	 * @param {Object}  data
	 * @param {Number}  data.id
	 * @param {String}  [data.reason]
	 * @returns {Promise}
	 */
	delete: (access, data) => {
		return access.can('certificates:delete', data.id)
			.then(() => {
				return internalCertificate.get(access, {id: data.id});
			})
			.then((row) => {
				if (!row) {
					throw new error.ItemNotFoundError(data.id);
				}

				return certificateModel
					.query()
					.where('id', row.id)
					.patch({
						is_deleted: 1
					})
					.then(() => {
						// Add to audit log
						row.meta = internalCertificate.cleanMeta(row.meta);

						return internalAuditLog.add(access, {
							action:      'deleted',
							object_type: 'certificate',
							object_id:   row.id,
							meta:        _.omit(row, omissions())
						});
					})
					.then(() => {
						if (row.provider === 'letsencrypt') {
							// Revoke the cert
							return internalCertificate.revokeLetsEncryptSsl(row);
						}
					});
			})
			.then(() => {
				return true;
			});
	},

	/**
	 * All Certs
	 *
	 * @param   {Access}  access
	 * @param   {Array}   [expand]
	 * @param   {String}  [search_query]
	 * @returns {Promise}
	 */
	getAll: (access, expand, search_query) => {
		return access.can('certificates:list')
			.then((access_data) => {
				let query = certificateModel
					.query()
					.where('is_deleted', 0)
					.groupBy('id')
					.omit(['is_deleted'])
					.allowEager('[owner]')
					.orderBy('nice_name', 'ASC');

				if (access_data.permission_visibility !== 'all') {
					query.andWhere('owner_user_id', access.token.getUserId(1));
				}

				// Query is used for searching
				if (typeof search_query === 'string') {
					query.where(function () {
						this.where('name', 'like', '%' + search_query + '%');
					});
				}

				if (typeof expand !== 'undefined' && expand !== null) {
					query.eager('[' + expand.join(', ') + ']');
				}

				return query;
			});
	},

	/**
	 * Report use
	 *
	 * @param   {Number}  user_id
	 * @param   {String}  visibility
	 * @returns {Promise}
	 */
	getCount: (user_id, visibility) => {
		let query = certificateModel
			.query()
			.count('id as count')
			.where('is_deleted', 0);

		if (visibility !== 'all') {
			query.andWhere('owner_user_id', user_id);
		}

		return query.first()
			.then((row) => {
				return parseInt(row.count, 10);
			});
	},

	/**
	 * @param   {Object} certificate
	 * @returns {Promise}
	 */
	writeCustomCert: (certificate) => {
		logger.info('Writing Custom Certificate:', certificate);

		const dir = '/data/custom_ssl/npm-' + certificate.id;

		return new Promise((resolve, reject) => {
			if (certificate.provider === 'letsencrypt') {
				reject(new Error('Refusing to write letsencrypt certs here'));
				return;
			}

			let certData = certificate.meta.certificate;
			if (typeof certificate.meta.intermediate_certificate !== 'undefined') {
				certData = certData + '\n' + certificate.meta.intermediate_certificate;
			}

			try {
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir);
				}
			} catch (err) {
				reject(err);
				return;
			}

			fs.writeFile(dir + '/fullchain.pem', certData, function (err) {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		})
			.then(() => {
				return new Promise((resolve, reject) => {
					fs.writeFile(dir + '/privkey.pem', certificate.meta.certificate_key, function (err) {
						if (err) {
							reject(err);
						} else {
							resolve();
						}
					});
				});
			});
	},

	/**
	 * @param   {Access}   access
	 * @param   {Object}   data
	 * @param   {Array}    data.domain_names
	 * @param   {String}   data.meta.letsencrypt_email
	 * @param   {Boolean}  data.meta.letsencrypt_agree
	 * @returns {Promise}
	 */
	createQuickCertificate: (access, data) => {
		return internalCertificate.create(access, {
			provider:     'letsencrypt',
			domain_names: data.domain_names,
			meta:         data.meta
		});
	},

	/**
	 * Validates that the certs provided are good.
	 * No access required here, nothing is changed or stored.
	 *
	 * @param   {Object}  data
	 * @param   {Object}  data.files
	 * @returns {Promise}
	 */
	validate: (data) => {
		return new Promise((resolve) => {
			// Put file contents into an object
			let files = {};
			_.map(data.files, (file, name) => {
				if (internalCertificate.allowedSslFiles.indexOf(name) !== -1) {
					files[name] = file.data.toString();
				}
			});

			resolve(files);
		})
			.then((files) => {
				// For each file, create a temp file and write the contents to it
				// Then test it depending on the file type
				let promises = [];
				_.map(files, (content, type) => {
					promises.push(new Promise((resolve) => {
						if (type === 'certificate_key') {
							resolve(internalCertificate.checkPrivateKey(content));
						} else {
							// this should handle `certificate` and intermediate certificate
							resolve(internalCertificate.getCertificateInfo(content, true));
						}
					}).then((res) => {
						return {[type]: res};
					}));
				});

				return Promise.all(promises)
					.then((files) => {
						let data = {};

						_.each(files, (file) => {
							data = _.assign({}, data, file);
						});

						return data;
					});
			});
	},

	/**
	 * @param   {Access}  access
	 * @param   {Object}  data
	 * @param   {Number}  data.id
	 * @param   {Object}  data.files
	 * @returns {Promise}
	 */
	upload: (access, data) => {
		return internalCertificate.get(access, {id: data.id})
			.then((row) => {
				if (row.provider !== 'other') {
					throw new error.ValidationError('Cannot upload certificates for this type of provider');
				}

				return internalCertificate.validate(data)
					.then((validations) => {
						if (typeof validations.certificate === 'undefined') {
							throw new error.ValidationError('Certificate file was not provided');
						}

						_.map(data.files, (file, name) => {
							if (internalCertificate.allowedSslFiles.indexOf(name) !== -1) {
								row.meta[name] = file.data.toString();
							}
						});

						// TODO: This uses a mysql only raw function that won't translate to postgres
						return internalCertificate.update(access, {
							id:           data.id,
							expires_on:   moment(validations.certificate.dates.to, 'X').format('YYYY-MM-DD HH:mm:ss'),
							domain_names: [validations.certificate.cn],
							meta:         _.clone(row.meta) // Prevent the update method from changing this value that we'll use later
						})
							.then((certificate) => {
								console.log('ROWMETA:', row.meta);
								certificate.meta = row.meta;
								return internalCertificate.writeCustomCert(certificate);
							});
					})
					.then(() => {
						return _.pick(row.meta, internalCertificate.allowedSslFiles);
					});
			});
	},

	/**
	 * Uses the openssl command to validate the private key.
	 * It will save the file to disk first, then run commands on it, then delete the file.
	 *
	 * @param {String}  private_key    This is the entire key contents as a string
	 */
	checkPrivateKey: (private_key) => {
		return tempWrite(private_key, '/tmp')
			.then((filepath) => {
				return new Promise((resolve, reject) => {
					const failTimeout = setTimeout(() => {
						reject(new error.ValidationError('Result Validation Error: Validation timed out. This could be due to the key being passphrase-protected.'));
					}, 10000);
					utils
						.exec('openssl pkey -in ' + filepath + ' -check -noout 2>&1 ')
						.then((result) => {
							clearTimeout(failTimeout);
							if (!result.toLowerCase().includes('key is valid')) {
								reject(new error.ValidationError('Result Validation Error: ' + result));
							}
							fs.unlinkSync(filepath);
							resolve(true);
						})
						.catch((err) => {
							clearTimeout(failTimeout);
							fs.unlinkSync(filepath);
							reject(new error.ValidationError('Certificate Key is not valid (' + err.message + ')', err));
						});
				});
			});
	},

	/**
	 * Uses the openssl command to both validate and get info out of the certificate.
	 * It will save the file to disk first, then run commands on it, then delete the file.
	 *
	 * @param {String}  certificate      This is the entire cert contents as a string
	 * @param {Boolean} [throw_expired]  Throw when the certificate is out of date
	 */
	getCertificateInfo: (certificate, throw_expired) => {
		return tempWrite(certificate, '/tmp')
			.then((filepath) => {
				return internalCertificate.getCertificateInfoFromFile(filepath, throw_expired)
					.then((certData) => {
						fs.unlinkSync(filepath);
						return certData;
					}).catch((err) => {
						fs.unlinkSync(filepath);
						throw err;
					});
			});
	},

	/**
	 * Uses the openssl command to both validate and get info out of the certificate.
	 * It will save the file to disk first, then run commands on it, then delete the file.
	 *
	 * @param {String}  certificate_file The file location on disk
	 * @param {Boolean} [throw_expired]  Throw when the certificate is out of date
	 */
	getCertificateInfoFromFile: (certificate_file, throw_expired) => {
		let certData = {};

		return utils.exec('openssl x509 -in ' + certificate_file + ' -subject -noout')
			.then((result) => {
				// subject=CN = something.example.com
				const regex = /(?:subject=)?[^=]+=\s+(\S+)/gim;
				const match = regex.exec(result);

				if (typeof match[1] === 'undefined') {
					throw new error.ValidationError('Could not determine subject from certificate: ' + result);
				}

				certData['cn'] = match[1];
			})
			.then(() => {
				return utils.exec('openssl x509 -in ' + certificate_file + ' -issuer -noout');
			})
			.then((result) => {
				// issuer=C = US, O = Let's Encrypt, CN = Let's Encrypt Authority X3
				const regex = /^(?:issuer=)?(.*)$/gim;
				const match = regex.exec(result);

				if (typeof match[1] === 'undefined') {
					throw new error.ValidationError('Could not determine issuer from certificate: ' + result);
				}

				certData['issuer'] = match[1];
			})
			.then(() => {
				return utils.exec('openssl x509 -in ' + certificate_file + ' -dates -noout');
			})
			.then((result) => {
				// notBefore=Jul 14 04:04:29 2018 GMT
				// notAfter=Oct 12 04:04:29 2018 GMT
				let validFrom = null;
				let validTo   = null;

				const lines = result.split('\n');
				lines.map(function (str) {
					const regex = /^(\S+)=(.*)$/gim;
					const match = regex.exec(str.trim());

					if (match && typeof match[2] !== 'undefined') {
						const date = parseInt(moment(match[2], 'MMM DD HH:mm:ss YYYY z').format('X'), 10);

						if (match[1].toLowerCase() === 'notbefore') {
							validFrom = date;
						} else if (match[1].toLowerCase() === 'notafter') {
							validTo = date;
						}
					}
				});

				if (!validFrom || !validTo) {
					throw new error.ValidationError('Could not determine dates from certificate: ' + result);
				}

				if (throw_expired && validTo < parseInt(moment().format('X'), 10)) {
					throw new error.ValidationError('Certificate has expired');
				}

				certData['dates'] = {
					from: validFrom,
					to:   validTo
				};

				return certData;
			}).catch((err) => {
				throw new error.ValidationError('Certificate is not valid (' + err.message + ')', err);
			});
	},

	/**
	 * Cleans the ssl keys from the meta object and sets them to "true"
	 *
	 * @param   {Object}  meta
	 * @param   {Boolean} [remove]
	 * @returns {Object}
	 */
	cleanMeta: function (meta, remove) {
		internalCertificate.allowedSslFiles.map((key) => {
			if (typeof meta[key] !== 'undefined' && meta[key]) {
				if (remove) {
					delete meta[key];
				} else {
					meta[key] = true;
				}
			}
		});

		return meta;
	},

	/**
	 * Request a certificate using the http challenge
	 * @param   {Object}  certificate   the certificate row
	 * @returns {Promise}
	 */
	requestLetsEncryptSsl: (certificate) => {
		logger.info('Requesting Let\'sEncrypt certificates for Cert #' + certificate.id + ': ' + certificate.domain_names.join(', '));

		const cmd = certbotCommand + ' certonly --non-interactive ' +
			'--config "' + letsencryptConfig + '" ' +
			'--cert-name "npm-' + certificate.id + '" ' +
			'--agree-tos ' +
			'--authenticator webroot ' +
			'--email "' + certificate.meta.letsencrypt_email + '" ' +
			'--preferred-challenges "dns,http" ' +
			'--domains "' + certificate.domain_names.join(',') + '" ' +
			(letsencryptStaging ? '--staging' : '');

		logger.info('Command:', cmd);

		return utils.exec(cmd)
			.then((result) => {
				logger.success(result);
				return result;
			});
	},

	/**
	 * @param   {Object}         certificate          the certificate row
	 * @param   {String}         dns_provider         the dns provider name (key used in `certbot-dns-plugins.js`)
	 * @param   {String | null}  credentials          the content of this providers credentials file
	 * @param   {String}         propagation_seconds  the cloudflare api token
	 * @returns {Promise}
	 */
	requestLetsEncryptSslWithDnsChallenge: (certificate) => {
		const dns_plugin = dnsPlugins[certificate.meta.dns_provider];

		if (!dns_plugin) {
			throw Error(`Unknown DNS provider '${certificate.meta.dns_provider}'`);
		}

		logger.info(`Requesting Let'sEncrypt certificates via ${dns_plugin.display_name} for Cert #${certificate.id}: ${certificate.domain_names.join(', ')}`);

		const credentialsLocation = '/etc/letsencrypt/credentials/credentials-' + certificate.id;
		const credentialsCmd      = 'mkdir -p /etc/letsencrypt/credentials 2> /dev/null; echo \'' + certificate.meta.dns_provider_credentials.replace('\'', '\\\'') + '\' > \'' + credentialsLocation + '\' && chmod 600 \'' + credentialsLocation + '\'';
		const prepareCmd          = 'pip install ' + dns_plugin.package_name + '==' + dns_plugin.package_version + ' ' + dns_plugin.dependencies;

		// Whether the plugin has a --<name>-credentials argument
		const hasConfigArg = certificate.meta.dns_provider !== 'route53';

		let mainCmd = certbotCommand + ' certonly --non-interactive ' +
			'--cert-name "npm-' + certificate.id + '" ' +
			'--agree-tos ' +
			'--email "' + certificate.meta.letsencrypt_email + '" ' +
			'--domains "' + certificate.domain_names.join(',') + '" ' +
			'--authenticator ' + dns_plugin.full_plugin_name + ' ' +
			(
				hasConfigArg
					? '--' + dns_plugin.full_plugin_name + '-credentials "' + credentialsLocation + '"'
					: ''
			) +
			(
				certificate.meta.propagation_seconds !== undefined
					? ' --' + dns_plugin.full_plugin_name + '-propagation-seconds ' + certificate.meta.propagation_seconds
					: ''
			) +
			(letsencryptStaging ? ' --staging' : '');

		// Prepend the path to the credentials file as an environment variable
		if (certificate.meta.dns_provider === 'route53') {
			mainCmd = 'AWS_CONFIG_FILE=\'' + credentialsLocation + '\' ' + mainCmd;
		}

		logger.info('Command:', `${credentialsCmd} && ${prepareCmd} && ${mainCmd}`);

		return utils.exec(credentialsCmd)
			.then(() => {
				return utils.exec(prepareCmd)
					.then(() => {
						return utils.exec(mainCmd)
							.then(async (result) => {
								logger.info(result);
								return result;
							});
					});
			}).catch(async (err) => {
				// Don't fail if file does not exist
				const delete_credentialsCmd = `rm -f '${credentialsLocation}' || true`;
				await utils.exec(delete_credentialsCmd);
				throw err;
			});
	},


	/**
	 * @param   {Access}  access
	 * @param   {Object}  data
	 * @param   {Number}  data.id
	 * @returns {Promise}
	 */
	renew: (access, data) => {
		return access.can('certificates:update', data)
			.then(() => {
				return internalCertificate.get(access, data);
			})
			.then((certificate) => {
				if (certificate.provider === 'letsencrypt') {
					const renewMethod = certificate.meta.dns_challenge ? internalCertificate.renewLetsEncryptSslWithDnsChallenge : internalCertificate.renewLetsEncryptSsl;

					return renewMethod(certificate)
						.then(() => {
							return internalCertificate.getCertificateInfoFromFile('/etc/letsencrypt/live/npm-' + certificate.id + '/fullchain.pem');
						})
						.then((cert_info) => {
							return certificateModel
								.query()
								.patchAndFetchById(certificate.id, {
									expires_on: moment(cert_info.dates.to, 'X').format('YYYY-MM-DD HH:mm:ss')
								});
						})
						.then((updated_certificate) => {
							// Add to audit log
							return internalAuditLog.add(access, {
								action:      'renewed',
								object_type: 'certificate',
								object_id:   updated_certificate.id,
								meta:        updated_certificate
							})
								.then(() => {
									return updated_certificate;
								});
						});
				} else {
					throw new error.ValidationError('Only Let\'sEncrypt certificates can be renewed');
				}
			});
	},

	/**
	 * @param   {Object}  certificate   the certificate row
	 * @returns {Promise}
	 */
	renewLetsEncryptSsl: (certificate) => {
		logger.info('Renewing Let\'sEncrypt certificates for Cert #' + certificate.id + ': ' + certificate.domain_names.join(', '));

		const cmd = certbotCommand + ' renew --force-renewal --non-interactive ' +
			'--config "' + letsencryptConfig + '" ' +
			'--cert-name "npm-' + certificate.id + '" ' +
			'--preferred-challenges "dns,http" ' +
			'--disable-hook-validation ' +
			(letsencryptStaging ? '--staging' : '');

		logger.info('Command:', cmd);

		return utils.exec(cmd)
			.then((result) => {
				logger.info(result);
				return result;
			});
	},

	/**
	 * @param   {Object}  certificate   the certificate row
	 * @returns {Promise}
	 */
	renewLetsEncryptSslWithDnsChallenge: (certificate) => {
		const dns_plugin = dnsPlugins[certificate.meta.dns_provider];

		if (!dns_plugin) {
			throw Error(`Unknown DNS provider '${certificate.meta.dns_provider}'`);
		}

		logger.info(`Renewing Let'sEncrypt certificates via ${dns_plugin.display_name} for Cert #${certificate.id}: ${certificate.domain_names.join(', ')}`);

		let mainCmd = certbotCommand + ' renew --non-interactive ' +
			'--cert-name "npm-' + certificate.id + '" ' +
			'--disable-hook-validation' +
			(letsencryptStaging ? ' --staging' : '');

		// Prepend the path to the credentials file as an environment variable
		if (certificate.meta.dns_provider === 'route53') {
			const credentialsLocation = '/etc/letsencrypt/credentials/credentials-' + certificate.id;
			mainCmd                   = 'AWS_CONFIG_FILE=\'' + credentialsLocation + '\' ' + mainCmd;
		}

		logger.info('Command:', mainCmd);

		return utils.exec(mainCmd)
			.then(async (result) => {
				logger.info(result);
				return result;
			});
	},

	/**
	 * @param   {Object}  certificate    the certificate row
	 * @param   {Boolean} [throw_errors]
	 * @returns {Promise}
	 */
	revokeLetsEncryptSsl: (certificate, throw_errors) => {
		logger.info('Revoking Let\'sEncrypt certificates for Cert #' + certificate.id + ': ' + certificate.domain_names.join(', '));

		const mainCmd = certbotCommand + ' revoke --non-interactive ' +
			'--cert-path "/etc/letsencrypt/live/npm-' + certificate.id + '/fullchain.pem" ' +
			'--delete-after-revoke ' +
			(letsencryptStaging ? '--staging' : '');

		// Don't fail command if file does not exist
		const delete_credentialsCmd = `rm -f '/etc/letsencrypt/credentials/credentials-${certificate.id}' || true`;

		logger.info('Command:', mainCmd + '; ' + delete_credentialsCmd);

		return utils.exec(mainCmd)
			.then(async (result) => {
				await utils.exec(delete_credentialsCmd);
				logger.info(result);
				return result;
			})
			.catch((err) => {
				logger.error(err.message);

				if (throw_errors) {
					throw err;
				}
			});
	},

	/**
	 * @param   {Object}  certificate
	 * @returns {Boolean}
	 */
	hasLetsEncryptSslCerts: (certificate) => {
		const letsencryptPath = '/etc/letsencrypt/live/npm-' + certificate.id;

		return fs.existsSync(letsencryptPath + '/fullchain.pem') && fs.existsSync(letsencryptPath + '/privkey.pem');
	},

	/**
	 * @param {Object}  in_use_result
	 * @param {Number}  in_use_result.total_count
	 * @param {Array}   in_use_result.proxy_hosts
	 * @param {Array}   in_use_result.redirection_hosts
	 * @param {Array}   in_use_result.dead_hosts
	 */
	disableInUseHosts: (in_use_result) => {
		if (in_use_result.total_count) {
			let promises = [];

			if (in_use_result.proxy_hosts.length) {
				promises.push(internalNginx.bulkDeleteConfigs('proxy_host', in_use_result.proxy_hosts));
			}

			if (in_use_result.redirection_hosts.length) {
				promises.push(internalNginx.bulkDeleteConfigs('redirection_host', in_use_result.redirection_hosts));
			}

			if (in_use_result.dead_hosts.length) {
				promises.push(internalNginx.bulkDeleteConfigs('dead_host', in_use_result.dead_hosts));
			}

			return Promise.all(promises);

		} else {
			return Promise.resolve();
		}
	},

	/**
	 * @param {Object}  in_use_result
	 * @param {Number}  in_use_result.total_count
	 * @param {Array}   in_use_result.proxy_hosts
	 * @param {Array}   in_use_result.redirection_hosts
	 * @param {Array}   in_use_result.dead_hosts
	 */
	enableInUseHosts: (in_use_result) => {
		if (in_use_result.total_count) {
			let promises = [];

			if (in_use_result.proxy_hosts.length) {
				promises.push(internalNginx.bulkGenerateConfigs('proxy_host', in_use_result.proxy_hosts));
			}

			if (in_use_result.redirection_hosts.length) {
				promises.push(internalNginx.bulkGenerateConfigs('redirection_host', in_use_result.redirection_hosts));
			}

			if (in_use_result.dead_hosts.length) {
				promises.push(internalNginx.bulkGenerateConfigs('dead_host', in_use_result.dead_hosts));
			}

			return Promise.all(promises);

		} else {
			return Promise.resolve();
		}
	}
};

module.exports = internalCertificate;
