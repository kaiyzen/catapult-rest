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

const dbFacade = require('./dbFacade');
const errors = require('../server/errors');
const routeResultTypes = require('./routeResultTypes');
const routeUtils = require('./routeUtils');

const { parsers } = routeUtils;

const getLimit = (validLimits, limit) =>
	(-1 === validLimits.indexOf(limit) ? undefined : limit);

const alignDown = (height, alignment) => (Math.floor((height - 1) / alignment) * alignment) + 1;

module.exports = {
	register: (server, db, { config }) => {
		const validPageSizes = routeUtils.generateValidPageSizes(config.pageSize); // throws if there is not at least one valid page size

		server.get('/block/:height', (req, res, next) => {
			const { height } = routeUtils.parseParams(req.params, {
				height: parsers.uint
			});

			return dbFacade.runHeightDependentOperation(db, height, () => db.blockAtHeight(height))
				.then(result => result.payload)
				.then(routeUtils.createSender(routeResultTypes.block).sendOne(height, res, next));
		});

		server.get(
			'/block/:height/transaction/:hash/merkle',
			routeUtils.blockRouteMerkleProcessor(db, 'numTransactions', 'transactionMerkleTree')
		);

		server.get('/block/:height/transactions', (req, res, next) => {
			const { height } = routeUtils.parseParams(req.params, {
				height: parsers.uint
			});
			const pagingOptions = routeUtils.parsePagingArguments(req.params);

			const operation = () => db.transactionsAtHeight(height, pagingOptions.id, pagingOptions.pageSize);
			return dbFacade.runHeightDependentOperation(db, height, operation)
				.then(result => {
					if (!result.isRequestValid) {
						res.send(errors.createNotFoundError(height));
						return next();
					}

					return routeUtils.createSender(routeResultTypes.transaction).sendArray('height', res, next)(result.payload);
				});
		});

		server.get('/blocks/:height/limit/:limit', (req, res, next) => {
			const { height, limit } = routeUtils.parseParams(req.params, {
				height: parsers.uint,
				limit: parsers.uint
			});
			const requestedLimit = getLimit(validPageSizes, limit);

			const sanitizedLimit = requestedLimit || validPageSizes[0];
			const sanitizedHeight = alignDown(height || 1, sanitizedLimit);
			if (sanitizedHeight !== height || !requestedLimit)
				return res.redirect(`/blocks/${sanitizedHeight}/limit/${sanitizedLimit}`, next); // redirect calls next

			return db.blocksFrom(height, requestedLimit).then(blocks => {
				res.send({ payload: blocks, type: routeResultTypes.block });
				next();
			});
		});
	}
};
