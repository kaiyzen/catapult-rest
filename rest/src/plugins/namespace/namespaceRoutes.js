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

const namespaceUtils = require('./namespaceUtils');
const dbUtils = require('../../db/dbUtils');
const routeUtils = require('../../routes/routeUtils');
const routeResultTypes = require('../../routes/routeResultTypes');
const errors = require('../../server/errors');
const AccountType = require('../AccountType');
const catapult = require('catapult-sdk');
const MongoDb = require('mongodb');

const { Binary } = MongoDb;
const { convertToLong } = dbUtils;
const { uint64 } = catapult.utils;

module.exports = {
	register: (server, db, services) => {
        const countRange = services.config.countRange;
		const namespaceSender = routeUtils.createSender('namespaceDescriptor');

		server.get('/namespace/:namespaceId', (req, res, next) => {
			const namespaceId = routeUtils.parseArgument(req.params, 'namespaceId', uint64.fromHex);
			return db.namespaceById(namespaceId)
				.then(namespaceSender.sendOne(req.params.namespaceId, res, next));
		});

		server.get('/account/:address/namespaces', (req, res, next) => {
			const accountAddress = routeUtils.parseArgument(req.params, 'address', 'address');
			const pagingOptions = routeUtils.parsePagingArguments(req.params);

			return db.namespacesByOwners([accountAddress], pagingOptions.id, pagingOptions.pageSize)
				.then(namespaces => routeUtils.createSender('namespaces').sendOne('accountId', res, next)({ namespaces }));
		});

		server.post('/account/namespaces', (req, res, next) => {
			const accountAddresses = routeUtils.parseArgumentAsArray(req.params, 'addresses', 'address');
			const pagingOptions = routeUtils.parsePagingArguments(req.params);
			return db.namespacesByOwners(accountAddresses, pagingOptions.id, pagingOptions.pageSize)
				.then(namespaces => routeUtils.createSender('namespaces').sendOne('addresses', res, next)({ namespaces }));
		});

		const collectNames = (namespaceNameTuples, namespaceIds) => {
			const type = catapult.model.EntityType.registerNamespace;
			return db.catapultDb.findNamesByIds(namespaceIds, type, { id: 'id', name: 'name', parentId: 'parentId' })
				.then(nameTuples => {
					nameTuples.forEach(nameTuple => {
						// db returns null instead of undefined when parentId is not present
						if (null === nameTuple.parentId)
							delete nameTuple.parentId;

						namespaceNameTuples.push(nameTuple);
					});

					// process all parent namespaces next
					return nameTuples
						.filter(nameTuple => undefined !== nameTuple.parentId)
						.map(nameTuple => nameTuple.parentId);
				});
		};

		server.post('/namespace/names', (req, res, next) => {
			const namespaceIds = routeUtils.parseArgumentAsArray(req.params, 'namespaceIds', uint64.fromHex);
			const nameTuplesFuture = new Promise(resolve => {
				const namespaceNameTuples = [];
				const chain = nextIds => {
					if (0 === nextIds.length)
						resolve(namespaceNameTuples);
					else
						collectNames(namespaceNameTuples, nextIds).then(chain);
				};

				collectNames(namespaceNameTuples, namespaceIds).then(chain);
			});

			return nameTuplesFuture.then(routeUtils.createSender('namespaceNameTuple').sendArray('namespaceIds', res, next));
		});

		server.post('/mosaic/names', namespaceUtils.aliasNamesRoutesProcessor(
			db,
			catapult.model.namespace.aliasType.mosaic,
			req => routeUtils.parseArgumentAsArray(req.params, 'mosaicIds', uint64.fromHex).map(convertToLong),
			(namespace, id) => namespace.namespace.alias.mosaicId.equals(id),
			'mosaicId',
			'mosaicNames'
		));

		server.post('/account/names', namespaceUtils.aliasNamesRoutesProcessor(
			db,
			catapult.model.namespace.aliasType.address,
			req => routeUtils.parseArgumentAsArray(req.params, 'addresses', 'address'),
			(namespace, id) => Buffer.from(namespace.namespace.alias.address.value())
				.equals(Buffer.from(new Binary(Buffer.from(id)).value())),
			'address',
			'accountNames'
		));

		// CURSORS - NAMESPACES

		// Gets namespace up to the identifier (non-inclusive).
		//
		// The duration may be:
		//  - from
		//  - since
		//
		// The identifier may be:
		//  - latest (returning up-to and including the latest namespace).
		//  - earliest (returning from the earliest namespace, IE, nothing).
		//  - A namespace ID.
		server.get('/namespaces/:duration/:namespace/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getNamespaceTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.namespaceTimeline,
				collectionName: 'namespaces',
				redirectUrl: limit => `/namespaces/${duration}/${params.namespace}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: 'namespaceDescriptor'
			});
		});

		// CURSORS - ACCOUNTS BY BALANCE

		// Gets accounts by balance up to the identifier (non-inclusive).
		//
		// The balance may be:
		//	- currency (private network only)
		//	- harvest (private network only)
		//	- xem (public network only)
		//
		// The duration may be:
		//  - from
		//  - since
		//
		// The identifier may be:
		//  - most (returning up-to and including the account with the most currency balance).
		//  - least (returning from the account with the least currency balance, IE, nothing).
		//  - An account address (base32 or hex-encoded).
		//  - An account public key (hex-encoded).
		server.get('/accounts/balance/:balance/:duration/:account/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');
			let timeline;
			if (params.balance === 'currency') {
				timeline = db.accountByCurrencyBalanceTimeline;
			} else if (params.balance === 'harvest') {
				timeline = db.accountByHarvestBalanceTimeline;
			} else if (params.balance === 'xem') {
				timeline = db.accountByXemBalanceTimeline;
			} else {
				throw errors.createInvalidArgumentError('invalid balance parameter.');
			}

			return routeUtils.getAccountTimeline({
				request,
				response,
				next,
				countRange,
				timeline: timeline,
				collectionName: 'accounts',
				redirectUrl: limit => `/accounts/balance/${params.balance}/${duration}/${params.account}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.account
			});
		});

		// CURSORS -- CONFIRMED TRANSACTIONS BY TYPE WITH FILTER

		// Gets transactions filtered by type and a subfilter up to the identifier (non-inclusive).
		//
		// The duration may be:
		//	- from
		//	- since
		//
		// The identifier may be:
		//	- latest (returning up-to and including the latest transaction).
		//	- earliest (returning from the earliest transaction, IE, nothing).
		//	- A transaction hash.
		//	- A transaction ID.
		//
		// The type may be:
		//	- Any valid transaction type in `EntityType`.
		//
		// The filter may be:
		//	- mosaic
		//	- multisig
		server.get('/transactions/:duration/:transaction/type/:type/filter/:filter/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getTransactionByTypeWithFilterTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.transactionByTypeWithFilterTimeline,
				collectionName: 'transactions',
				redirectUrl: limit => `/transactions/${duration}/${params.transaction}/type/${params.type}/filter/${params.filter}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.transaction
			});
		});
	}
};
