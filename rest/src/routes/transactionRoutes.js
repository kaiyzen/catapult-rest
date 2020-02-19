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
const catapult = require('catapult-sdk');

const { convert } = catapult.utils;
const { PacketType } = catapult.packet;

module.exports = {
	register: (server, db, services) => {
		const countRange = services.config.countRange;
		const sender = routeUtils.createSender(routeResultTypes.transaction);

		routeUtils.addPutPacketRoute(
			server,
			services.connections,
			{ routeName: '/transaction', packetType: PacketType.pushTransactions },
			params => routeUtils.parseArgument(params, 'payload', convert.hexToUint8)
		);

		routeUtils.addGetPostDocumentRoutes(
			server,
			sender,
			{ base: '/transaction', singular: 'transactionId', plural: 'transactionIds' },
			// params has already been converted by a parser below, so it is: string - in case of objectId, Uint8Array - in case of hash
			params => (('string' === typeof params[0]) ? db.transactionsByIds(params) : db.transactionsByHashes(params)),
			(transactionId, index, array) => {
				if (0 < index && array[0].length !== transactionId.length)
					throw Error(`all ids must be homogeneous, element ${index}`);

				if (routeUtils.validateValue(transactionId, 'objectId'))
					return routeUtils.parseValue(transactionId, 'objectId');
				if (routeUtils.validateValue(transactionId, 'hash256'))
					return routeUtils.parseValue(transactionId, 'hash256');

				throw Error(`invalid length of transaction id '${transactionId}'`);
			}
		);

		// CURSORS - CONFIRMED TRANSACTIONS

		// Gets transactions up to the identifier (non-inclusive).
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
		server.get('/transactions/:duration/:transaction/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getTransactionTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.transactionTimeline,
				collectionName: 'transactions',
				redirectUrl: limit => `/transactions/${duration}/${params.transaction}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.transaction
			});
		});

		// CURSORS -- CONFIRMED TRANSACTIONS BY TYPE

		// Gets transactions filtered by type up to the identifier (non-inclusive).
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
		server.get('/transactions/:duration/:transaction/type/:type/limit/:limit', (request, response, next) => {
			const params = request.params;
      const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getTransactionByTypeTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.transactionByTypeTimeline,
				collectionName: 'transactions',
				redirectUrl: limit => `/transactions/${duration}/${params.transaction}/type/${params.type}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.transaction
			});
		});

		// CURSORS -- UNCONFIRMED TRANSACTIONS

		// Gets unconfirmed transactions up to the identifier (non-inclusive).
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
		server.get('/transactions/unconfirmed/:duration/:transaction/limit/:limit', (request, response, next) => {
			const params = request.params;
      const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getTransactionTimeline({
        request,
        response,
        next,
        countRange,
        timeline: db.transactionTimeline,
        collectionName: 'unconfirmedTransactions',
        redirectUrl: limit => `/transactions/unconfirmed/${duration}/${params.transaction}/limit/${limit}`,
        duration: duration,
        transformer: info => info,
        resultType: routeResultTypes.transaction
      });
		});

		// CURSORS -- PARTIAL TRANSACTIONS

		// Gets partial transactions up to the identifier (non-inclusive).
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
		server.get('/transactions/partial/:duration/:transaction/limit/:limit', (request, response, next) => {
			const params = request.params;
			const duration = routeUtils.parseArgument(params, 'duration', 'duration');

			return routeUtils.getTransactionTimeline({
				request,
				response,
				next,
				countRange,
				timeline: db.transactionTimeline,
				collectionName: 'partialTransactions',
				redirectUrl: limit => `/transactions/partial/${duration}/${params.transaction}/limit/${limit}`,
				duration: duration,
				transformer: info => info,
				resultType: routeResultTypes.transaction
			});
		});
	}
};
