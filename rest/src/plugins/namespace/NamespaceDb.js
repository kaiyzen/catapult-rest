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

const { convertToLong } = require('../../db/dbUtils');
const Timeline = require('../../db/Timeline');
const AccountType = require('../AccountType');
const catapult = require('catapult-sdk');
const MongoDb = require('mongodb');

const { Long, ObjectId } = MongoDb;
const { uint64 } = catapult.utils;

const createActiveConditions = () => {
	const conditions = { $and: [{ 'meta.active': true }] };
	return conditions;
};

// Network currency namespace ID (internal only).
const CURRENCY_ID = uint64.fromHex('85bbea6cc462b244');

// Network harvest namespace ID (internal only).
const HARVEST_ID = uint64.fromHex('941299b2b7e1291c');

// XEM namespace ID (public net only).
const XEM_ID = uint64.fromHex('d525ad41d95fcf29');

class NamespaceDb {
	/**
	 * Creates NamespaceDb around CatapultDb.
	 * @param {module:db/CatapultDb} db Catapult db instance.
	 */
	constructor(db) {
		this.catapultDb = db;

		// Namespace timeline.
    const namespaceMinArgs = () => [Timeline.minLong(), Timeline.minObjectId()];
    const namespaceMaxArgs = () => [Timeline.maxLong(), Timeline.maxObjectId()];
    const namespaceToArgs = (namespace) => [namespace.namespace.startHeight, namespace._id];
    this.namespaceTimeline = new Timeline({
      database: this,
      ...Timeline.generateAbsoluteParameters({
        baseMethodName: 'namespaces',
        generateMinArgs: namespaceMinArgs,
        generateMaxArgs: namespaceMaxArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'Id',
        baseMethodName: 'namespaces',
        idMethodName: 'rawNamespaceById',
        generateArgs: namespaceToArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'ObjectId',
        baseMethodName: 'namespaces',
        idMethodName: 'rawNamespaceByObjectId',
        generateArgs: namespaceToArgs
      })
    });

    // Account by currency balance timeline.
		const accountMinArgs = () => [Timeline.minLong(), Timeline.minLong(), Timeline.minObjectId()];
		const accountMaxArgs = () => [Timeline.maxLong(), Timeline.maxLong(), Timeline.maxObjectId()];
		const accountBalanceToArgs = (account) => [account.account.balance, account.account.publicKeyHeight, account._id];
    this.accountByCurrencyBalanceTimeline = new Timeline({
      database: this,
      ...Timeline.generateAbsoluteParameters({
        baseMethodName: 'accountsByCurrencyBalance',
        generateMinArgs: accountMinArgs,
        generateMaxArgs: accountMaxArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'Address',
        baseMethodName: 'accountsByCurrencyBalance',
        idMethodName: 'rawAccountWithCurrencyBalanceByAddress',
        generateArgs: accountBalanceToArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'PublicKey',
        baseMethodName: 'accountsByCurrencyBalance',
        idMethodName: 'rawAccountWithCurrencyBalanceByPublicKey',
        generateArgs: accountBalanceToArgs
      })
    });

    // Account by harvest balance timeline.
    this.accountByHarvestBalanceTimeline = new Timeline({
      database: this,
      ...Timeline.generateAbsoluteParameters({
        baseMethodName: 'accountsByHarvestBalance',
        generateMinArgs: accountMinArgs,
        generateMaxArgs: accountMaxArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'Address',
        baseMethodName: 'accountsByHarvestBalance',
        idMethodName: 'rawAccountWithHarvestBalanceByAddress',
        generateArgs: accountBalanceToArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'PublicKey',
        baseMethodName: 'accountsByHarvestBalance',
        idMethodName: 'rawAccountWithHarvestBalanceByPublicKey',
        generateArgs: accountBalanceToArgs
      })
    });

    // Account by XEM balance timeline.
    this.accountByXemBalanceTimeline = new Timeline({
      database: this,
      ...Timeline.generateAbsoluteParameters({
        baseMethodName: 'accountsByXemBalance',
        generateMinArgs: accountMinArgs,
        generateMaxArgs: accountMaxArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'Address',
        baseMethodName: 'accountsByXemBalance',
        idMethodName: 'rawAccountWithXemBalanceByAddress',
        generateArgs: accountBalanceToArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'PublicKey',
        baseMethodName: 'accountsByXemBalance',
        idMethodName: 'rawAccountWithXemBalanceByPublicKey',
        generateArgs: accountBalanceToArgs
      })
    });

    // Transaction by type with filter timeline.
    const transactionMinArgs = () => [Timeline.minLong(), -1];
		const transactionMaxArgs = () => [Timeline.maxLong(), 0];
		const transactionToArgs = (info) => [info.meta.height, info.meta.index];
		this.transactionByTypeWithFilterTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'transactionsByTypeWithFilter',
				generateMinArgs: transactionMinArgs,
				generateMaxArgs: transactionMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Hash',
				baseMethodName: 'transactionsByTypeWithFilter',
				idMethodName: 'rawTransactionByHash',
				generateArgs: transactionToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Id',
				baseMethodName: 'transactionsByTypeWithFilter',
				idMethodName: 'rawTransactionById',
				generateArgs: transactionToArgs
			})
		});
	}

  // region raw namespace retrieval

	// Internal method: retrieve namespace by object ID.
  // Does not process internal _id.
	rawNamespaceByObjectId(collectionName, id) {
		const namespaceId = new ObjectId(id);
		const condition = { _id: { $eq: namespaceId } };
		return this.catapultDb.queryDocument(collectionName, condition);
	}

	// Internal method: retrieve namespace by namespace ID.
  // Does not process internal _id.
  rawNamespaceById(collectionName, id) {
		const namespaceId = new Long(id[0], id[1]);
		const conditions = { $or: [] };

		for (let level = 0; 3 > level; ++level) {
			const conjunction = createActiveConditions();
			conjunction.$and.push({ [`namespace.level${level}`]: namespaceId });
			conjunction.$and.push({ 'namespace.depth': level + 1 });

			conditions.$or.push(conjunction);
		}

		return this.catapultDb.queryDocument(collectionName, conditions);
	}

  // endregion

  // region well-known mosaic retrieval

	// Internal method: retrieve network currency mosaic (private nodes only).
	networkCurrencyMosaic() {
		return this.rawNamespaceById('namespaces', CURRENCY_ID)
			.then(namespace => {
				if (undefined === namespace)
					return undefined;
				return namespace.namespace.alias.mosaicId;
			});
	}

	// Internal method: retrieve network harvest mosaic (private nodes only).
	networkHarvestMosaic() {
		return this.rawNamespaceById('namespaces', HARVEST_ID)
			.then(namespace => {
				if (undefined === namespace)
					return undefined;
				return namespace.namespace.alias.mosaicId;
			});
	}

	// Internal method: retrieve XEM mosaic (public nodes only).
	networkXemMosaic() {
		return this.rawNamespaceById('namespaces', XEM_ID)
			.then(namespace => {
				if (undefined === namespace)
					return undefined;
				return namespace.namespace.alias.mosaicId;
			});
	}

  // endregion

  // region cursor namespace retrieval

	// Internal method to find sorted namespaces from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedNamespaces(collectionName, condition, sortAscending, count) {
		// Sort by descending startHeight, then by descending ID.
		// Don't sort solely on ID, since it will break if 32-bit time wraps.
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'namespace.startHeight': order, _id: order };
		const finalSort = { 'namespace.startHeight': -1, _id: -1 };
		return this.catapultDb.database.collection(collectionName)
      .find(condition)
      .sort(initialSort)
      .limit(count)
      .sort(finalSort)
      .toArray()
			.then(this.catapultDb.sanitizer.copyAndDeleteIds);
	}

	// Internal method to get namespaces up to (non-inclusive) the block height
	// and the namespace ID, returning at max `count` items.
	namespacesFrom(collectionName, height, id, count) {
		const condition = { $or: [
			{ 'namespace.startHeight': { $eq: height }, _id: { $lt: id } },
			{ 'namespace.startHeight': { $lt: height } }
		]};

		return this.sortedNamespaces(collectionName, condition, false, count)
			.then(namespaces => Promise.resolve(namespaces));
	}

	// Internal method to get namespaces since (non-inclusive) the block height
	// and the namespace ID, returning at max `count` items.
	namespacesSince(collectionName, height, id, count) {
		const condition = { $or: [
			{ 'namespace.startHeight': { $eq: height }, _id: { $gt: id } },
			{ 'namespace.startHeight': { $gt: height } }
		]};

		return this.sortedNamespaces(collectionName, condition, true, count)
			.then(namespaces => Promise.resolve(namespaces));
	}

	// endregion

	// region account by namespace-linked mosaic retrieval

	addFieldMosaicBalance(mosaicId) {
		// Reduce over the account mosaics, and add the currency amount if
		// the mosaics match, otherwise, add 0.
		return {
			$reduce: {
				input: "$account.mosaics",
				initialValue: { $toLong: 0 },
				in: { $add : [
					"$$value",
					{
						$cond: {
							if: { $eq: [ "$$this.id", mosaicId ] },
							then: "$$this.amount",
							else: { $toLong: 0 }
						}
					}
				] }
			}
		}
	}

	// Internal method to find sort accounts by balance in a mosaic ID from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedAccountsByMosaicBalance(collectionName, mosaicId, match, sortAscending, count) {
		const aggregation = [
			{ $addFields: {
				'account.importance': this.catapultDb.addFieldImportance(),
				'account.importanceHeight': this.catapultDb.addFieldImportanceHeight(),
				'account.balance': this.addFieldMosaicBalance(mosaicId),
			} },
			{ $match: match }
		];
		// Need secondary public key height and ID height to sort by when the
		// account's public key was known to network.
		const projection = { 'account.importances': 0, 'account.balance': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'account.balance': order, 'account.publicKeyHeight': order, _id: order };
		const finalSort = { 'account.balance': -1, 'account.publicKeyHeight': -1, _id: -1 };

		return this.catapultDb.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.catapultDb.sanitizer.deleteIds);
	}

	// endregion

	// region cursor account by currency mosaic retrieval

	rawAccountWithCurrencyBalanceByAddress(collectionName, address) {
		return this.networkCurrencyMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;

			const addFields = { $addFields: {
				'account.importance': this.catapultDb.addFieldImportance(),
				'account.importanceHeight': this.catapultDb.addFieldImportanceHeight(),
				'account.balance': this.addFieldMosaicBalance(mosaicId)
			} };
			const projection = { 'account.importances': 0 };
			return this.catapultDb.rawAccountByAddress(collectionName, address, addFields, projection);
		});
	}

	rawAccountWithCurrencyBalanceByPublicKey(collectionName, publicKey) {
		const address = this.catapultDb.publicKeyToAddress(publicKey);
		return this.rawAccountWithCurrencyBalanceByAddress(collectionName, address);
	}

	sortedAccountsByCurrencyBalance(collectionName, match, sortAscending, count) {
		return this.networkCurrencyMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;
			return this.sortedAccountsByMosaicBalance(collectionName, mosaicId, match, sortAscending, count);
		});
	}

	accountsByCurrencyBalanceFrom(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$lt', balance, height, id);
		return this.sortedAccountsByCurrencyBalance(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	accountsByCurrencyBalanceSince(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$gt', balance, height, id);
		return this.sortedAccountsByCurrencyBalance(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region cursor account by harvest mosaic retrieval

	rawAccountWithHarvestBalanceByAddress(collectionName, address) {
		return this.networkHarvestMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;

			const addFields = { $addFields: {
				'account.importance': this.catapultDb.addFieldImportance(),
				'account.importanceHeight': this.catapultDb.addFieldImportanceHeight(),
				'account.balance': this.addFieldMosaicBalance(mosaicId)
			} };
			const projection = { 'account.importances': 0 };
			return this.catapultDb.rawAccountByAddress(collectionName, address, addFields, projection);
		});
	}

	rawAccountWithHarvestBalanceByPublicKey(collectionName, publicKey) {
		const address = this.catapultDb.publicKeyToAddress(publicKey);
		return this.rawAccountWithHarvestBalanceByAddress(collectionName, address);
	}

	sortedAccountsByHarvestBalance(collectionName, match, sortAscending, count) {
		return this.networkHarvestMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;
			return this.sortedAccountsByMosaicBalance(collectionName, mosaicId, match, sortAscending, count);
		});
	}

	accountsByHarvestBalanceFrom(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$lt', balance, height, id);
		return this.sortedAccountsByHarvestBalance(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	accountsByHarvestBalanceSince(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$gt', balance, height, id);
		return this.sortedAccountsByHarvestBalance(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region cursor account by xem mosaic retrieval

	rawAccountWithXemBalanceByAddress(collectionName, address) {
		return this.networkXemMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;

			const addFields = { $addFields: {
				'account.importance': this.catapultDb.addFieldImportance(),
				'account.importanceHeight': this.catapultDb.addFieldImportanceHeight(),
				'account.balance': this.addFieldMosaicBalance(mosaicId)
			} };
			const projection = { 'account.importances': 0 };
			return this.catapultDb.rawAccountByAddress(collectionName, address, addFields, projection);
		});
	}

	rawAccountWithXemBalanceByPublicKey(collectionName, publicKey) {
		const address = this.catapultDb.publicKeyToAddress(publicKey);
		return this.rawAccountWithXemBalanceByAddress(collectionName, address);
	}

	sortedAccountsByXemBalance(collectionName, match, sortAscending, count) {
		return this.networkXemMosaic().then(mosaicId => {
			if (undefined === mosaicId)
				return undefined;
			return this.sortedAccountsByMosaicBalance(collectionName, mosaicId, match, sortAscending, count);
		});
	}

	accountsByXemBalanceFrom(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$lt', balance, height, id);
		return this.sortedAccountsByXemBalance(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	accountsByXemBalanceSince(collectionName, balance, height, id, numAccounts) {
		const match = this.catapultDb.accountMatchCondition('balance', '$gt', balance, height, id);
		return this.sortedAccountsByXemBalance(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region cursor transaction by type with filter helpers

	// Re-export ID methods here for arrayById.
	rawTransactionByHash(...args) {
		return this.catapultDb.rawTransactionByHash(...args);
	}

	rawTransactionById(...args) {
		return this.catapultDb.rawTransactionById(...args);
	}

	// region cursor transaction by type with filter retrieval

	// Internal method to simplify requesting transactions by type with filter.
	// The initialMatch should contain all the logic to query a transaction
	// by transaction type before or after a given transaction.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	transactionsByTypeWithFilter(collectionName, initialMatch, type, filter, sortAscending, count) {
		const aggregation = [
			{ $match: initialMatch }
		];
		const projection = { 'meta.addresses': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'meta.height': order, 'meta.index': order };
		const finalSort = { 'meta.height': -1, 'meta.index': -1 };

		if (type === catapult.model.EntityType.transfer) {
			if (filter === 'mosaic') {
				// transfer/mosaic
				const networkIds = [CURRENCY_ID, HARVEST_ID].map(convertToLong);
				aggregation.push(
					// Dynamically add field for if the type has mosaics mosaics.
					{ $addFields: {
						'meta.hasMosaics': {
							$reduce: {
								input: "$transaction.mosaics",
								initialValue: false,
								in: { $or: ["$$value", { $not: { $in: ["$$this.id", networkIds] } } ] }
							}
						}
					} },
					// Add secondary match condition for those with mosaics.
					{ $match: { 'meta.hasMosaics': { $eq: true } } }
				);
				projection['meta.hasMosaics'] = 0;
			} else if (filter === 'multisig') {
				// transfer/multisig
				aggregation.push(
					// Lookup stage to fetch the account by the address provided.
					// We can lookup over an array for localField as of MongoDB 3.4,
					// and then match to a scalar foreignField, returning
					// an array of matched values.
					{ $lookup: {
						from: 'multisigs',
						localField: 'meta.addresses',
		        foreignField: "multisig.accountAddress",
			      as: 'meta.linkedMultisigAccounts'
					} },
					// Add fields locally, which will determine if we have multisig accounts.
					{ $addFields: {
						'meta.multisigAccountCount': { $size: '$meta.linkedMultisigAccounts' }
					} },
					// Add secondary match condition for those with multisig accounts.
					{ $match: { 'meta.multisigAccountCount': { $gt: 0 } } }
				);
				projection['meta.linkedMultisigAccounts'] = 0;
				projection['meta.multisigAccountCount'] = 0;
			} else {
				// Unknown filter parameter.
				throw new Error('unknown filter parameter.');
			}
		} else {
			// Unknown type parameter.
			throw new Error('unknown type parameter.');
		}

		return this.catapultDb.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.catapultDb.sanitizer.copyAndDeleteIds)
			.then(transactions => this.catapultDb.addAggregateTransactions(collectionName, transactions));
	}

	// Internal method to get transactions filtered by type and a subfilter up to
	// (non-inclusive) the block height and transaction index, returning at max
	// `numTransactions` items.
	transactionsByTypeWithFilterFrom(collectionName, height, index, type, filter, count) {
		const initialMatch = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ 'transaction.type': { $eq: type } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $lt: index } },
				{ 'meta.height': { $lt: height } }
			]},
		]};

		return this.transactionsByTypeWithFilter(collectionName, initialMatch, type, filter, false, count);
	}

	// Internal method to get transactions filtered by type and a subfilter since
	// (non-inclusive) the block height and transaction index, returning at max
	// `numTransactions` items.
	transactionsByTypeWithFilterSince(collectionName, height, index, type, filter, count) {
		const initialMatch = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ 'transaction.type': { $eq: type } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $gt: index } },
				{ 'meta.height': { $gt: height } }
			]},
		]};

		return this.transactionsByTypeWithFilter(collectionName, initialMatch, type, filter, true, count);
	}

	// endregion

	// region namespace retrieval

	/**
	 * Retrieves a namespace.
	 * @param {module:catapult.utils/uint64~uint64} id Namespace id.
	 * @returns {Promise.<object>} Namespace.
	 */
	namespaceById(id) {
		const namespaceId = new Long(id[0], id[1]);
		const conditions = { $or: [] };

		for (let level = 0; 3 > level; ++level) {
			const conjunction = createActiveConditions();
			conjunction.$and.push({ [`namespace.level${level}`]: namespaceId });
			conjunction.$and.push({ 'namespace.depth': level + 1 });

			conditions.$or.push(conjunction);
		}

		return this.catapultDb.queryDocument('namespaces', conditions)
			.then(this.catapultDb.sanitizer.copyAndDeleteId);
	}

	/**
	 * Retrieves namespaces owned by specified owners.
	 * @param {array<{Uint8Array}>} addresses Account addresses.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} options Additional options.
	 * @returns {Promise.<array>} Owned namespaces.
	 */
	namespacesByOwners(addresses, id, pageSize, options) {
		const buffers = addresses.map(address => Buffer.from(address));
		const conditions = createActiveConditions();
		conditions.$and.push({ 'namespace.ownerAddress': { $in: buffers } });

		return this.catapultDb.queryPagedDocuments('namespaces', conditions, id, pageSize, options)
			.then(this.catapultDb.sanitizer.copyAndDeleteIds);
	}

	/**
	 * Retrieves non expired namespaces aliasing mosaics or addresses.
	 * @param {Array.<module:catapult.model.namespace/aliasType>} aliasType Alias type.
	 * @param {*} ids Set of mosaic or address ids.
	 * @returns {Promise.<array>} Active namespaces aliasing ids.
	 */
	activeNamespacesWithAlias(aliasType, ids) {
		const aliasFilterCondition = {
			[catapult.model.namespace.aliasType.mosaic]: () => ({ 'namespace.alias.mosaicId': { $in: ids.map(convertToLong) } }),
			[catapult.model.namespace.aliasType.address]: () => ({ 'namespace.alias.address': { $in: ids.map(id => Buffer.from(id)) } })
		};

		return this.catapultDb.database.collection('blocks').countDocuments()
			.then(numBlocks => {
				const conditions = { $and: [] };
				conditions.$and.push(aliasFilterCondition[aliasType]());
				conditions.$and.push({ 'namespace.alias.type': aliasType });
				conditions.$and.push({
					$or: [
						{ 'namespace.endHeight': convertToLong(-1) },
						{ 'namespace.endHeight': { $gt: numBlocks } }]
				});

				return this.catapultDb.queryDocuments('namespaces', conditions);
			});
	}

	// endregion

	/**
	 * Retrieves transactions that registered the specified namespaces.
	 * @param {Array.<module:catapult.utils/uint64~uint64>} namespaceIds Namespace ids.
	 * @returns {Promise.<array>} Register namespace transactions.
	 */
	registerNamespaceTransactionsByNamespaceIds(namespaceIds) {
		const type = catapult.model.EntityType.registerNamespace;
		const conditions = { $and: [] };
		conditions.$and.push({ 'transaction.id': { $in: namespaceIds } });
		conditions.$and.push({ 'transaction.type': type });
		return this.catapultDb.queryDocuments('transactions', conditions);
	}
}

module.exports = NamespaceDb;
