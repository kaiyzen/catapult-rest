/*
 * Copyright (c) 2016-present,
 * Jaguar0625, gimre, BloodyRookie, Tech Bureau, Corp. All rights reserved.
 *
 * This file is part of Catapult.
 *
 * Catapult is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Catapult is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Catapult.  If not, see <http://www.gnu.org/licenses/>.
 */

const routeResultTypes = require('./routeResultTypes');
const routeUtils = require('./routeUtils');
const AccountType = require('../plugins/AccountType');
const errors = require('../server/errors');

module.exports = {
	register: (server, db, services) => {
		const countRange = services.config.countRange;
		const transactionSender = routeUtils.createSender(routeResultTypes.transaction);

		const accountIdToPublicKey = (type, accountId) => {
			if (AccountType.publicKey === type)
				return Promise.resolve(accountId);

			return routeUtils.addressToPublicKey(db, accountId);
		};

		server.get('/account/:accountId', (req, res, next) => {
			const [type, accountId] = routeUtils.parseArgument(req.params, 'accountId', 'accountId');
			const sender = routeUtils.createSender(routeResultTypes.account);
			return db.accountsByIds([{ [type]: accountId }])
				.then(sender.sendOne(req.params.accountId, res, next));
		});

		server.post('/account', (req, res, next) => {
			if (req.params.publicKeys && req.params.addresses)
				throw errors.createInvalidArgumentError('publicKeys and addresses cannot both be provided');

			const idOptions = Array.isArray(req.params.publicKeys)
				? { keyName: 'publicKeys', parserName: 'publicKey', type: AccountType.publicKey }
				: { keyName: 'addresses', parserName: 'address', type: AccountType.address };

			const accountIds = routeUtils.parseArgumentAsArray(req.params, idOptions.keyName, idOptions.parserName);
			const sender = routeUtils.createSender(routeResultTypes.account);

			return db.accountsByIds(accountIds.map(accountId => ({ [idOptions.type]: accountId })))
				.then(sender.sendArray(idOptions.keyName, res, next));
		});

		// region account transactions

		const transactionStates = [
			{ dbPostfix: 'Confirmed', routePostfix: '' },
			{ dbPostfix: 'Incoming', routePostfix: '/incoming' },
			{ dbPostfix: 'Unconfirmed', routePostfix: '/unconfirmed' }
		];

		transactionStates.concat(services.config.transactionStates).forEach(state => {
			server.get(`/account/:accountId/transactions${state.routePostfix}`, (req, res, next) => {
				const [type, accountId] = routeUtils.parseArgument(req.params, 'accountId', 'accountId');
				const transactionTypes = req.params.type ? routeUtils.parseArgumentAsArray(req.params, 'type', 'uint') : undefined;
				const pagingOptions = routeUtils.parsePagingArguments(req.params);
				const ordering = routeUtils.parseArgument(req.params, 'ordering', input => ('id' === input ? 1 : -1));

				const accountAddress = (AccountType.publicKey === type)
					? address.publicKeyToAddress(accountId, networkInfo.networks[services.config.network.name].id)
					: accountId;

				return db[`accountTransactions${state.dbPostfix}`](
					accountAddress,
					transactionTypes,
					pagingOptions.id,
					pagingOptions.pageSize,
					ordering
				).then(transactionSender.sendArray('accountId', res, next));
			});
		});

		server.get('/account/:accountId/transactions/outgoing', (req, res, next) => {
			const [type, accountId] = routeUtils.parseArgument(req.params, 'accountId', 'accountId');
			const transactionTypes = req.params.type ? routeUtils.parseArgumentAsArray(req.params, 'type', 'uint') : undefined;
			const pagingOptions = routeUtils.parsePagingArguments(req.params);
			const ordering = routeUtils.parseArgument(req.params, 'ordering', input => ('id' === input ? 1 : -1));

			return accountIdToPublicKey(type, accountId).then(publicKey =>
				db.accountTransactionsOutgoing(publicKey, transactionTypes, pagingOptions.id, pagingOptions.pageSize, ordering)
					.then(transactionSender.sendArray('accountId', res, next)))
				.catch(() => {
					transactionSender.sendArray('accountId', res, next)([]);
				});
		});

		// endregion

		// CURSORS - ACCOUNTS BY IMPORTANCE

		// Gets accounts by importance up to the identifier (non-inclusive).
		//
		// The duration may be:
		//	- from
		//	- since
		//
		// The identifier may be:
		//	- most (returning up-to and including the account with the most importance).
		//	- least (returning from the account with the least importance, IE, nothing).
		//	- An account address (base32 or hex-encoded).
		//	- An account public key (hex-encoded).
		server.get('/accounts/importance/:duration/:account/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');
			return routeUtils.getAccountTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.accountByImportanceTimeline,
				collectionName: 'accounts',
				redirectUrl: limit => `/accounts/importance/${duration}/${params.account}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.account
			});
		});

		// CURSORS - ACCOUNTS BY HARVESTED

		// Gets accounts by harvested parameter up to the identifier (non-inclusive).
		//
		// The harvested may be:
		//	- blocks
		//	- fees
		//
		// The duration may be:
		//	- from
		//	- since
		//
		// The identifier may be:
		//	- most (returning up-to and including the account with the most harvested blocks).
		//	- least (returning from the account with the least harvested blocks, IE, nothing).
		//	- An account address (base32 or hex-encoded).
		//	- An account public key (hex-encoded).
		server.get('/accounts/harvested/:harvested/:duration/:account/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');
			let timeline;
			if (params.harvested === 'blocks') {
				timeline = db.accountByHarvestedBlocksTimeline;
			} else if (params.harvested === 'fees') {
				timeline = db.accountByHarvestedFeesTimeline;
			} else {
				throw errors.createInvalidArgumentError('invalid harvested parameter.');
			}

			return routeUtils.getAccountTimeline({
				request,
				response,
				next,
				countRange,
				timeline,
				collectionName: 'accounts',
				redirectUrl: limit => `/accounts/harvested/${params.harvested}/${duration}/${params.account}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.account
			});
		});
	}
};
