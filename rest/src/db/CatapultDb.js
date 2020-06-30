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

/** @module db/CatapultDb */

const connector = require('./connector');
const { convertToLong } = require('./dbUtils');
const Timeline = require('./Timeline');
const catapult = require('catapult-sdk');
const MongoDb = require('mongodb');

const { EntityType } = catapult.model;
const { ObjectId } = MongoDb;

const { address, EntityType } = catapult.model;
const { Long, ObjectId } = MongoDb;


const isAggregateType = document => EntityType.aggregateComplete === document.transaction.type
	|| EntityType.aggregateBonded === document.transaction.type;

const extractAggregateIds = transactions => {
	const aggregateIds = [];
	const transactionMap = {};
	transactions
		.filter(isAggregateType)
		.forEach(info => {
			const aggregateId = info.meta.id;
			aggregateIds.push(aggregateId);
			transactionMap[aggregateId.toString()] = info.transaction;
		});

	return { aggregateIds, transactionMap };
}

const addAggregateTransaction = (transactionMap, aggregateTransaction) => {
	const transaction = transactionMap[aggregateTransaction.meta.aggregateId];
	if (!transaction.transactions)
		transaction.transactions = [];

	transaction.transactions.push(aggregateTransaction);
}

const createAccountTransactionsAllConditions = (publicKey, networkId) => {
	const decodedAddress = address.publicKeyToAddress(publicKey, networkId);
	const bufferPublicKey = Buffer.from(publicKey);
	const bufferAddress = Buffer.from(decodedAddress);
	return {
		$or: [
			{ 'transaction.cosignatures.signerPublicKey': bufferPublicKey },
			{ 'meta.addresses': bufferAddress }
		]
	};
};

const createSanitizer = () => ({
	copyAndDeleteId: dbObject => {
		if (dbObject) {
			Object.assign(dbObject.meta, { id: dbObject._id });
			delete dbObject._id;
		}

		return dbObject;
	},

	copyAndDeleteIds: dbObjects => {
		dbObjects.forEach(dbObject => {
			Object.assign(dbObject.meta, { id: dbObject._id });
			delete dbObject._id;
		});

		return dbObjects;
	},

	deleteId: dbObject => {
		if (dbObject)
			delete dbObject._id;

		return dbObject;
	},

	deleteIds: dbObjects => {
		dbObjects.forEach(dbObject => {
			delete dbObject._id;
		});
		return dbObjects;
	},

	renameId: dbObject => {
		if (dbObject) {
			dbObject.id = dbObject._id;
			delete dbObject._id;
		}

		return dbObject;
	},

	renameIds: dbObjects => {
		dbObjects.forEach(dbObject => {
			dbObject.id = dbObject._id;
			delete dbObject._id;
		});
		return dbObjects;
	}
});

const mapToPromise = dbObject => Promise.resolve(null === dbObject ? undefined : dbObject);

const buildBlocksFromOptions = (height, numBlocks, chainHeight) => {
	const one = convertToLong(1);
	const startHeight = height.isZero() ? chainHeight.subtract(numBlocks).add(one) : height;

	// In all cases endHeight is actually max height + 1.
	const calculatedEndHeight = startHeight.add(numBlocks);
	const chainEndHeight = chainHeight.add(one);

	const endHeight = calculatedEndHeight.lessThan(chainEndHeight) ? calculatedEndHeight : chainEndHeight;
	return { startHeight, endHeight, numBlocks: endHeight.subtract(startHeight).toNumber() };
};

const getBoundedPageSize = (pageSize, pagingOptions) =>
	Math.max(pagingOptions.pageSizeMin, Math.min(pagingOptions.pageSizeMax, pageSize || pagingOptions.pageSizeDefault));

const TransactionGroup = Object.freeze({
	confirmed: 'transactions',
	unconfirmed: 'unconfirmedTransactions',
	partial: 'partialTransactions'
});

// Calculate the start and end block height from the provided from height.
const calculateFromHeight = (height, chainHeight, numBlocks) => {
	const one = convertToLong(1);
	const count = convertToLong(numBlocks);
	// We want the numBlocks preceding the height, non-inclusive.
	// If we've provided a number above the blockHeight, go to
	// chainHeight + 1.
	const endHeight = height.greaterThan(chainHeight) ? chainHeight.add(one) : height;
	const startHeight = endHeight.greaterThan(count) ? endHeight.subtract(count) : one;
	return { startHeight, endHeight };
}

// Calculate the start and end block height from the provided since height.
const calculateSinceHeight = (height, chainHeight, numBlocks) => {
	const one = convertToLong(1);
	const count = convertToLong(numBlocks);
	// We want the numBlocks following the height, non-inclusive.
	// If we've provided a number above the blockHeight, go to
	// chainHeight + 1 for the start (returns nothing, even if a block is added).
	const startHeight = height.greaterThan(chainHeight) ? chainHeight.add(one) : height;
	const endHeight = startHeight.add(count);
	return { startHeight, endHeight };
}

// Implied method to add the importance field.
// Calculates if importances is empty, if so, returns Long(0), otherwise,
// extracts the field from the struct.
const addFieldImportanceImpl = (field) => {
	return {
		$cond: {
			if: { $gt: [ { $size: "$account.importances" }, 0 ] },
			then: {
				$let: {
					vars: {
						lastImportance: { $arrayElemAt: [ "$account.importances", -1 ] }
					},
					in: `$$lastImportance.${field}`
				}
			},
			else: { $toLong: 0 }
		}
	};
}

// DATABASE

class CatapultDb {
	// region construction / connect / disconnect

	constructor(options) {
		this.networkId = options.networkId;
		if (!this.networkId)
			throw Error('network id is required');

		this.pagingOptions = {
			pageSizeMin: options.pageSizeMin,
			pageSizeMax: options.pageSizeMax,
			pageSizeDefault: options.pageSizeDefault
		};
		this.sanitizer = createSanitizer();

		// Block timeline.
		const blockMinArgs = () => [Timeline.minLong()];
		const blockMaxArgs = () => [Timeline.maxLong()];
		const blockToArgs = (info) => [info.block.height];
		this.blockTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'blocksv2',
				generateMinArgs: blockMinArgs,
				generateMaxArgs: blockMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Hash',
				baseMethodName: 'blocksv2',
				idMethodName: 'rawBlockByHash',
				generateArgs: blockToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Height',
				baseMethodName: 'blocksv2',
				idMethodName: 'rawBlockByHeight',
				generateArgs: blockToArgs
			})
		});

		// Transaction timeline.
		const transactionMinArgs = () => [Timeline.minLong(), -1];
		const transactionMaxArgs = () => [Timeline.maxLong(), 0];
		const transactionToArgs = (info) => [info.meta.height, info.meta.index];
		this.transactionTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'transactions',
				generateMinArgs: transactionMinArgs,
				generateMaxArgs: transactionMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Hash',
				baseMethodName: 'transactions',
				idMethodName: 'rawTransactionByHash',
				generateArgs: transactionToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Id',
				baseMethodName: 'transactions',
				idMethodName: 'rawTransactionById',
				generateArgs: transactionToArgs
			})
		});

		// Transaction by type timeline.
		this.transactionByTypeTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'transactionsByType',
				generateMinArgs: transactionMinArgs,
				generateMaxArgs: transactionMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Hash',
				baseMethodName: 'transactionsByType',
				idMethodName: 'rawTransactionByHash',
				generateArgs: transactionToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Id',
				baseMethodName: 'transactionsByType',
				idMethodName: 'rawTransactionById',
				generateArgs: transactionToArgs
			})
		});

		// Accounts by importance timeline.
		const accountMinArgs = () => [Timeline.minLong(), Timeline.minLong(), Timeline.minObjectId()];
		const accountMaxArgs = () => [Timeline.maxLong(), Timeline.maxLong(), Timeline.maxObjectId()];
		const accountImportanceToArgs = (account) => [account.account.importance, account.account.publicKeyHeight, account._id];
		this.accountByImportanceTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'accountsByImportance',
				generateMinArgs: accountMinArgs,
				generateMaxArgs: accountMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Address',
				baseMethodName: 'accountsByImportance',
				idMethodName: 'rawAccountWithImportanceByAddress',
				generateArgs: accountImportanceToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'PublicKey',
				baseMethodName: 'accountsByImportance',
				idMethodName: 'rawAccountWithImportanceByPublicKey',
				generateArgs: accountImportanceToArgs
			})
		});

		// Accounts by harvested blocks timeline.
		const accountHarvestedBlocksToArgs = (account) => [account.account.harvestedBlocks, account.account.publicKeyHeight, account._id];
		this.accountByHarvestedBlocksTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'accountsByHarvestedBlocks',
				generateMinArgs: accountMinArgs,
				generateMaxArgs: accountMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Address',
				baseMethodName: 'accountsByHarvestedBlocks',
				idMethodName: 'rawAccountWithHarvestedBlocksByAddress',
				generateArgs: accountHarvestedBlocksToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'PublicKey',
				baseMethodName: 'accountsByHarvestedBlocks',
				idMethodName: 'rawAccountWithHarvestedBlocksByPublicKey',
				generateArgs: accountHarvestedBlocksToArgs
			})
		});

		// Accounts by harvested fees timeline.
		const accountHarvestedFeesToArgs = (account) => [account.account.harvestedFees, account.account.publicKeyHeight, account._id];
		this.accountByHarvestedFeesTimeline = new Timeline({
			database: this,
			...Timeline.generateAbsoluteParameters({
				baseMethodName: 'accountsByHarvestedFees',
				generateMinArgs: accountMinArgs,
				generateMaxArgs: accountMaxArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'Address',
				baseMethodName: 'accountsByHarvestedFees',
				idMethodName: 'rawAccountWithHarvestedFeesByAddress',
				generateArgs: accountHarvestedFeesToArgs
			}),
			...Timeline.generateIdParameters({
				keyName: 'PublicKey',
				baseMethodName: 'accountsByHarvestedFees',
				idMethodName: 'rawAccountWithHarvestedFeesByPublicKey',
				generateArgs: accountHarvestedFeesToArgs
			})
		});
	}

	connect(url, dbName) {
		return connector.connectToDatabase(url, dbName)
			.then(client => {
				this.client = client;
				this.database = client.db();
			});
	}

	close() {
		if (!this.database)
			return Promise.resolve();

		return new Promise(resolve => {
			this.client.close(resolve);
			this.client = undefined;
			this.database = undefined;
		});
	}

	// endregion

	// region helpers

	queryDocument(collectionName, conditions, projection) {
		const collection = this.database.collection(collectionName);
		return collection.findOne(conditions, { projection })
			.then(mapToPromise);
	}

	queryDocuments(collectionName, conditions) {
		const collection = this.database.collection(collectionName);
		return collection.find(conditions)
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	queryRawDocuments(collectionName, conditions) {
		return this.database.collection(collectionName).find(conditions).toArray();
	}

	queryDocumentsAndCopyIds(collectionName, conditions, options = {}) {
		const collection = this.database.collection(collectionName);
		return collection.find(conditions)
			.project(options.projection)
			.toArray()
			.then(this.sanitizer.renameIds);
	}

	queryPagedDocuments(collectionName, conditions, id, pageSize, options = {}) {
		const sortOrder = options.sortOrder || -1;
		let allConditions = conditions;

		if (id) {
			allConditions = {
				$and: [
					conditions,
					{ _id: { [0 > sortOrder ? '$lt' : '$gt']: new ObjectId(id) } }
				]
			};
		}

		const collection = this.database.collection(collectionName);
		return collection.find(allConditions)
			.project(options.projection)
			.sort({ _id: sortOrder })
			.limit(getBoundedPageSize(pageSize, this.pagingOptions))
			.toArray();
	}

	// endregion

	// region retrieval

	/**
	 * Retrieves sizes of database collections.
	 * @returns {Promise} Promise that resolves to the sizes of collections in the database.
	 */
	storageInfo() {
		const blockCountPromise = this.database.collection('blocks').countDocuments();
		const transactionCountPromise = this.database.collection('transactions').countDocuments();
		const accountCountPromise = this.database.collection('accounts').countDocuments();
		return Promise.all([blockCountPromise, transactionCountPromise, accountCountPromise])
			.then(storageInfo => ({ numBlocks: storageInfo[0], numTransactions: storageInfo[1], numAccounts: storageInfo[2] }));
	}

	chainStatistic() {
		return this.queryDocument('chainStatistic', {}, { _id: 0 });
	}

	chainStatisticCurrent() {
		return this.queryDocument('chainStatistic', {}, { _id: 0 })
			.then(chainStatistic => chainStatistic.current);
	}

	/**
	 * Retrieves filtered and paginated blocks.
	 * @param {Uint8Array} signerPublicKey Filters by signer public key
	 * @param {Uint8Array} beneficiaryAddress Filters by beneficiary address
	 * @param {object} options Options for ordering and pagination. Can have an `offset`, and must contain the `sortField`, `sortDirection`,
	 * `pageSize` and `pageNumber`. 'sortField' must be within allowed 'sortingOptions'.
	 * @returns {Promise.<object>} Blocks page.
	 */
	blocks(signerPublicKey, beneficiaryAddress, options) {
		const sortingOptions = {
			id: '_id',
			height: 'block.height'
		};

		const conditions = [];

		if (options.offset)
			conditions.push({ [sortingOptions[options.sortField]]: { [1 === options.sortDirection ? '$gt' : '$lt']: options.offset } });

		if (signerPublicKey)
			conditions.push({ 'block.signerPublicKey': Buffer.from(signerPublicKey) });

		if (beneficiaryAddress)
			conditions.push({ 'block.beneficiaryAddress': Buffer.from(beneficiaryAddress) });

		const sortConditions = { $sort: { [sortingOptions[options.sortField]]: options.sortDirection } };

		return this.queryPagedDocuments_2(conditions, [], sortConditions, 'blocks', options);
	}

	blockAtHeight(height) {
		return this.queryDocument(
			'blocks',
			{ 'block.height': convertToLong(height) },
			{ 'meta.transactionMerkleTree': 0, 'meta.statementMerkleTree': 0 }
		).then(this.sanitizer.renameId);
	}

	blockWithMerkleTreeAtHeight(height, merkleTreeName) {
		const blockMerkleTreeNames = ['transactionMerkleTree', 'statementMerkleTree'];
		const excludedMerkleTrees = {};
		blockMerkleTreeNames.filter(merkleTree => merkleTree !== merkleTreeName)
			.forEach(merkleTree => { excludedMerkleTrees[`meta.${merkleTree}`] = 0; });
		return this.queryDocument('blocks', { 'block.height': convertToLong(height) }, excludedMerkleTrees)
			.then(this.sanitizer.deleteId);
	}

	blocksFrom(height, numBlocks) {
		if (0 === numBlocks)
			return Promise.resolve([]);

		return this.chainStatisticCurrent().then(chainStatistic => {
			const blockCollection = this.database.collection('blocks');
			const options = buildBlocksFromOptions(convertToLong(height), convertToLong(numBlocks), chainStatistic.height);

			return blockCollection.find({ 'block.height': { $gte: options.startHeight, $lt: options.endHeight } })
				.project({ 'meta.transactionMerkleTree': 0, 'meta.statementMerkleTree': 0 })
				.sort({ 'block.height': -1 })
				.toArray()
				.then(this.sanitizer.deleteIds)
				.then(blocks => Promise.resolve(blocks));
		});
	}


	/**
	 * Retrieves the fee multiplier for the last (higher on the chain) numBlocks blocks
	 * @param {int} numBlocks Number of blocks to retrieve.
	 * @returns {Promise} Promise that resolves to feeMultiplier array
	 */
	latestBlocksFeeMultiplier(numBlocks) {
		if (0 === numBlocks)
			return Promise.resolve([]);

		return this.database.collection('blocks').find()
			.sort({ 'block.height': -1 })
			.limit(numBlocks)
			.project({ 'block.feeMultiplier': 1 })
			.toArray()
			.then(blocks => Promise.resolve(blocks.map(block => block.block.feeMultiplier)));
	}

	// endregion

  // region cursor block retrieval

  // Internal method: retrieve block by hash.
	// Does not process internal _id.
  rawBlockByHash(collectionName, hash) {
		const condition = { 'meta.hash': { $eq: Buffer.from(hash) } };
		return this.queryDocument(collectionName, condition);
  }

  // Internal method: retrieve block by height.
	// Does not process internal _id.
  rawBlockByHeight(collectionName, height) {
    const blockHeight = new Long(height[0], height[1]);
		const condition = { 'block.height': { $eq: blockHeight } };
		return this.queryDocument(collectionName, condition);
  }

	// Internal method to find sorted blocks from query.
	// Note:
	//	No need for an initial sort, since the start and end height
	//	are limited in the condition.
	sortedBlocks(collectionName, condition, count) {
		const projection = { 'meta.transactionMerkleTree': 0, 'meta.statementMerkleTree': 0 };
		const sorting = { 'block.height': -1 };
		return this.database.collection(collectionName)
			.find(condition)
			.sort(sorting)
			.project(projection)
			.limit(count)
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	// Updated version of blocksFrom.
	// Gets blocks up to (non-inclusive) the height provided,
	// returning at max `count` items.
	blocksv2From(collectionName, height, count) {
		if (0 === count)
			return Promise.resolve([]);

		return this.chainStatisticCurrent().then(chainStatistic => {
			const { startHeight, endHeight } = calculateFromHeight(height, chainStatistic.height, count);
			const condition = { 'block.height': { $gte: startHeight, $lt: endHeight } };
			return this.sortedBlocks(collectionName, condition, count)
				.then(blocks => Promise.resolve(blocks));
		});
	}

	// Gets blocks starting from (non-inclusive) the height provided,
	// returning at max `count` items.
	blocksv2Since(collectionName, height, count) {
		if (0 === count)
			return Promise.resolve([]);

		return this.chainStatisticCurrent().then(chainStatistic => {
			const { startHeight, endHeight } = calculateSinceHeight(height, chainStatistic.height, count);
			const condition = { 'block.height': { $gt: startHeight, $lte: endHeight } };
      return this.sortedBlocks(collectionName, condition, count)
				.then(blocks => Promise.resolve(blocks));
		});
	}

	// endregion

	// region transaction retrieval

	queryDependentDocuments(collectionName, aggregateIds) {
		if (0 === aggregateIds.length)
			return Promise.resolve([]);

		return this.queryDocumentsAndCopyIds(collectionName, { 'meta.aggregateId': { $in: aggregateIds } });
	}

	/**
	 * Makes a paginated query with the provided arguments.
	 * @param {array<object>} queryConditions The conditions that determine the query results, may be empty.
	 * @param {array<string>} removedFields Field names to be hidden from the query results, may be empty.
	 * @param {object} sortConditions Condition that describes the order of the results, must be set.
	 * @param {string} collectionName Name of the collection to be queried.
	 * @param {object} options Pagination options, must contain `pageSize` and `pageNumber` (starting at 1).
	 * @returns {Promise.<object>} Page result, contains the attributes `data` with the actual results, and `paging` with pagination
	 * metadata - which is comprised of: `totalEntries`, `pageNumber`, and `pageSize`.
	 */
	queryPagedDocuments_2(queryConditions, removedFields, sortConditions, collectionName, options) {
		const conditions = [];
		if (queryConditions.length)
			conditions.push(1 === queryConditions.length ? { $match: queryConditions[0] } : { $match: { $and: queryConditions } });

		conditions.push(sortConditions);

		const { pageSize } = options;
		const pageIndex = options.pageNumber - 1;

		const facet = [
			{ $skip: pageSize * pageIndex },
			{ $limit: pageSize }
		];

		// rename _id to id
		facet.push({ $set: { id: '$_id' } });
		removedFields.push('_id');

		if (0 < Object.keys(removedFields).length)
			facet.push({ $unset: removedFields });

		conditions.push({
			$facet: {
				data: facet,
				pagination: [
					{ $count: 'totalEntries' },
					{
						$set: {
							pageNumber: options.pageNumber,
							pageSize
						}
					}
				]
			}
		});

		return this.database.collection(collectionName)
			.aggregate(conditions, { promoteLongs: false })
			.toArray()
			.then(result => {
				const formattedResult = result[0];

				// when query is empty, mongodb does not fill the pagination info
				if (!formattedResult.pagination.length)
					formattedResult.pagination = { totalEntries: 0, pageNumber: options.pageNumber, pageSize };
				else
					formattedResult.pagination = formattedResult.pagination[0];

				formattedResult.pagination.totalPages = Math.ceil(
					formattedResult.pagination.totalEntries / formattedResult.pagination.pageSize
				);

				return formattedResult;
			});
	}

	/**
	 * Retrieves filtered and paginated transactions.
	 * @param {string} group Transactions group on which the query is made.
	 * @param {object} filters Filters to be applied: `address` for an involved address in the query, `signerPublicKey`, `recipientAddress`,
	 * `height`, `embedded`, `transactionTypes` array of uint. If `address` is provided, other account related filters are omitted.
	 * @param {object} options Options for ordering and pagination. Can have an `offset`, and must contain the `sortField`, `sortDirection`,
	 * `pageSize` and `pageNumber`. 'sortField' must be within allowed 'sortingOptions'.
	 * @returns {Promise.<object>} Transactions page.
	 */
	transactions(group, filters, options) {
		const sortingOptions = { id: '_id' };

		const buildAccountConditions = () => {
			if (filters.address)
				return { 'meta.addresses': Buffer.from(filters.address) };

			const accountConditions = [];
			if (filters.signerPublicKey) {
				const signerPublicKeyCondition = { 'transaction.signerPublicKey': Buffer.from(filters.signerPublicKey) };
				accountConditions.push(signerPublicKeyCondition);
			}

			if (filters.recipientAddress) {
				const recipientAddressCondition = { 'transaction.recipientAddress': Buffer.from(filters.recipientAddress) };
				accountConditions.push(recipientAddressCondition);
			}

			if (Object.keys(accountConditions).length)
				return 1 < Object.keys(accountConditions).length ? { $and: accountConditions } : accountConditions[0];

			return undefined;
		};

		const buildConditions = () => {
			const conditions = [];

			if (options.offset)
				conditions.push({ [sortingOptions[options.sortField]]: { [1 === options.sortDirection ? '$gt' : '$lt']: options.offset } });

			if (filters.height)
				conditions.push({ 'meta.height': convertToLong(filters.height) });

			if (!filters.embedded)
				conditions.push({ 'meta.aggregateId': { $exists: false } });

			if (undefined !== filters.transactionTypes)
				conditions.push({ 'transaction.type': { $in: filters.transactionTypes } });

			const accountConditions = buildAccountConditions();
			if (accountConditions)
				conditions.push(accountConditions);

			return conditions;
		};

		const removedFields = ['meta.addresses'];
		const sortConditions = { $sort: { [sortingOptions[options.sortField]]: options.sortDirection } };
		const conditions = buildConditions();

		return this.queryPagedDocuments_2(conditions, removedFields, sortConditions, TransactionGroup[group], options);
	}

	transactionsByIdsImpl(collectionName, conditions) {
		return this.queryDocumentsAndCopyIds(collectionName, conditions, { projection: { 'meta.addresses': 0 } })
			.then(documents => Promise.all(documents.map(document => {
				if (!document || !isAggregateType(document))
					return document;

				return this.queryDependentDocuments(collectionName, [document.id]).then(dependentDocuments => {
					dependentDocuments.forEach(dependentDocument => {
						if (!document.transaction.transactions)
							document.transaction.transactions = [];

						document.transaction.transactions.push(dependentDocument);
					});

					return document;
				});
			})));
	}

	transactionsByIds(group, ids) {
		return this.transactionsByIdsImpl(TransactionGroup[group], { _id: { $in: ids.map(id => new ObjectId(id)) } });
	}

	transactionsByHashes(group, hashes) {
		return this.transactionsByIdsImpl(TransactionGroup[group], { 'meta.hash': { $in: hashes.map(hash => Buffer.from(hash)) } });
	}

	/**
	 * Return (id, name, parent) tuples for transactions with type and with id in set of ids.
	 * @param {*} ids Set of transaction ids.
	 * @param {*} transactionType Transaction type.
	 * @param {object} fieldNames Descriptor for fields used in query.
	 * @returns {Promise.<array>} Promise that is resolved when tuples are ready.
	 */
	findNamesByIds(ids, transactionType, fieldNames) {
		const queriedIds = ids.map(convertToLong);
		const conditions = {
			$match: {
				'transaction.type': transactionType,
				[`transaction.${fieldNames.id}`]: { $in: queriedIds }
			}
		};

		const grouping = {
			$group: {
				_id: `$transaction.${fieldNames.id}`,
				[fieldNames.id]: { $first: `$transaction.${fieldNames.id}` },
				[fieldNames.name]: { $first: `$transaction.${fieldNames.name}` },
				[fieldNames.parentId]: { $first: `$transaction.${fieldNames.parentId}` }
			}
		};

		const collection = this.database.collection('transactions');
		return collection.aggregate([conditions, grouping])
			.sort({ _id: -1 })
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	// region account transactions

	/**
	 * Retrieves confirmed transactions for which an account is the sender or receiver.
	 * An account is sender or receiver if its address is in the transaction meta addresses.
	 * @param {Uint8Array} accountAddress Account address who sends or receives the transactions.
	 * @param {uintArray} transactionTypes Transaction types to filter by.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} ordering Page ordering.
	 * @returns {Promise.<array>} Confirmed transactions.
	 */
	accountTransactionsConfirmed(accountAddress, transactionTypes, id, pageSize, ordering) {
		const conditions = undefined !== transactionTypes
			? createMetaAddressesAndTypeConditions(accountAddress, transactionTypes)
			: createMetaAddressesConditions(accountAddress);
		return this.queryTransactions(conditions, id, pageSize, { sortOrder: ordering });
	}

	// endregion

  // region raw transaction retrieval

	// Internal method: retrieve transaction by hash.
	// Does not process internal _id.
  rawTransactionByHash(collectionName, hash) {
		const condition = { 'meta.hash': { $eq: Buffer.from(hash) } };
		return this.queryDocument(collectionName, condition);
  }

	// Internal method: retrieve transaction by ID.
	// Does not process internal _id.
  rawTransactionById(collectionName, id) {
		const transactionId = new ObjectId(id);
		const condition = { _id: { $eq: transactionId } };
		return this.queryDocument(collectionName, condition)
			.then(this.sanitizer.copyAndDeleteId);
  }

	// endregion

  // region cursor transaction retrieval

  // Internal method to query dependent aggregate transactions.
  queryAggregateTransactions(collectionName, aggregateIds)  {
  	if (0 === aggregateIds.length)
			return Promise.resolve([]);

		const aggregateCondition = { 'meta.aggregateId': { $in: aggregateIds } };
		return this.database.collection(collectionName)
			.find(aggregateCondition)
			.toArray()
			.then(this.sanitizer.copyAndDeleteIds);
  }

  // Internal method to add aggregate transactions.
  addAggregateTransactions(collectionName, transactions) {
  	// Add dependent aggregate transactions.
		const { aggregateIds, transactionMap } = extractAggregateIds(transactions);
		return this.queryAggregateTransactions(collectionName, aggregateIds)
			.then(documents => {
				documents.forEach(aggregate => addAggregateTransaction(transactionMap, aggregate));
				return transactions;
			});
  }

	// Internal method to find sorted transactions from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedTransactions(collectionName, condition, sortAscending, count) {
		const projection = { 'meta.addresses': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'meta.height': order, 'meta.index': order };
		const finalSort = { 'meta.height': -1, 'meta.index': -1 };
		return this.database.collection(collectionName)
			.find(condition)
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.sanitizer.copyAndDeleteIds)
			.then(transactions => this.addAggregateTransactions(collectionName, transactions));
	}

	// Internal method to get transactions up to (non-inclusive) the block height
	// and transaction index, returning at max `count` items.
	transactionsFrom(collectionName, height, index, count) {
		const condition = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $lt: index } },
				{ 'meta.height': { $lt: height } }
			]},
		]};

		return this.sortedTransactions(collectionName, condition, false, count)
			.then(transactions => Promise.resolve(transactions));
	}

	// Internal method to get transactions since (non-inclusive) the block height
	// and transaction index, returning at max `count` items.
	transactionsSince(collectionName, height, index, count) {
		const condition = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $gt: index } },
				{ 'meta.height': { $gt: height } }
			]},
		]};

		return this.sortedTransactions(collectionName, condition, true, count)
			.then(transactions => Promise.resolve(transactions));
	}

	// endregion

  // region cursor transaction by type retrieval

	// Internal method to get transactions filtered by type up to (non-inclusive) the block height
	// and transaction index, returning at max `numTransactions` items.
	transactionsByTypeFrom(collectionName, height, index, type, count) {
		const condition = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ 'transaction.type': { $eq: type } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $lt: index } },
				{ 'meta.height': { $lt: height } }
			]},
		]};

		return this.sortedTransactions(collectionName, condition, false, count)
			.then(transactions => Promise.resolve(transactions));
	}

	// Internal method to get transactions filtered by type since (non-inclusive) the block height
	// and transaction index, returning at max `numTransactions` items.
	transactionsByTypeSince(collectionName, height, index, type, count) {
		const condition = { $and: [
			{ 'meta.aggregateId': { $exists: false } },
			{ 'transaction.type': { $eq: type } },
			{ $or: [
				{ 'meta.height': { $eq: height }, 'meta.index': { $gt: index } },
				{ 'meta.height': { $gt: height } }
			]},
		]};

		return this.sortedTransactions(collectionName, condition, true, count)
			.then(transactions => Promise.resolve(transactions));
	}

	// endregion

	// region transaction retrieval for account

	/**
	 * Retrieves confirmed incoming transactions for which an account is the receiver.
	 * @param {Uint8Array} accountAddress Account address who receives the transactions.
	 * @param {uintArray} transactionTypes Transaction types to filter by.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} ordering Page ordering.
	 * @returns {Promise.<array>} Confirmed transactions.
	 */
	accountTransactionsIncoming(accountAddress, transactionTypes, id, pageSize, ordering) {
		const bufferAddress = Buffer.from(accountAddress);

		const getInnerTransactionConditions = () => {
			const conditions = {
				$and: [
					{ 'meta.aggregateId': { $exists: true } },
					{ 'transaction.recipientAddress': bufferAddress }
				]
			};

			if (undefined !== transactionTypes)
				conditions.$and.push({ 'transaction.type': { $in: transactionTypes } });

			return conditions;
		};

		// Search for inner transactions by recipient address
		return this.database.collection('transactions')
			.find(getInnerTransactionConditions())
			.project({ 'meta.aggregateId': 1 })
			.toArray()
			.then(transactions => transactions.map(transaction => transaction.meta.aggregateId))
			.then(transactionIds => {
				const baseCondition = {
					$or: [
						{ 'transaction.recipientAddress': bufferAddress },
						{ id: { $in: transactionIds } }
					]
				};

				const conditions = undefined !== transactionTypes
					? { $and: [{ 'transaction.type': { $in: transactionTypes } }, baseCondition] }
					: baseCondition;

				return this.queryTransactions(conditions, id, pageSize, { sortOrder: ordering });
			});
	}

	/**
	 * Retrieves confirmed outgoing transactions for which an account is the sender.
	 * @param {Uint8Array} publicKey Public key of the account who sends the transactions.
	 * @param {uintArray} transactionTypes Transaction types to filter by.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} ordering Page ordering.
	 * @returns {Promise.<array>} Confirmed transactions.
	 */
	accountTransactionsOutgoing(publicKey, transactionTypes, id, pageSize, ordering) {
		const bufferPublicKey = Buffer.from(publicKey);
		const conditions = undefined !== transactionTypes
			? { $and: [{ 'transaction.signerPublicKey': bufferPublicKey }, { 'transaction.type': { $in: transactionTypes } }] }
			: { 'transaction.signerPublicKey': bufferPublicKey };

		return this.queryTransactions(conditions, id, pageSize, { sortOrder: ordering });
	}

	/**
	 * Retrieves unconfirmed transactions for which an account is the sender or receiver.
	 * An account is sender or receiver if its address is in the unconfirmed transaction meta addresses.
	 * @param {Uint8Array} accountAddress Account address who sends or receives the unconfirmed transactions.
	 * @param {uint} transactionTypes Transaction types to filter by.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} ordering Page ordering.
	 * @returns {Promise.<array>} Unconfirmed transactions.
	 */
	accountTransactionsUnconfirmed(accountAddress, transactionTypes, id, pageSize, ordering) {
		const conditions = undefined !== transactionTypes
			? createMetaAddressesAndTypeConditions(accountAddress, transactionTypes)
			: createMetaAddressesConditions(accountAddress);

		return this.queryTransactions(conditions, id, pageSize, { collectionName: 'unconfirmedTransactions', sortOrder: ordering });
	}

	/**
	 * Retrieves partial transactions for which an account is the sender or receiver.
	 * An account is sender or receiver if its address is in the partial transaction meta addresses.
	 * @param {Uint8Array} accountAddress Account address who sends or receives the partial transactions.
	 * @param {uintArray} transactionTypes Transaction types to filter by.
	 * @param {string} id Paging id.
	 * @param {int} pageSize Page size.
	 * @param {object} ordering Page ordering.
	 * @returns {Promise.<array>} Partial transactions.
	 */
	accountTransactionsPartial(accountAddress, transactionTypes, id, pageSize, ordering) {
		const conditions = undefined !== transactionTypes
			? createMetaAddressesAndTypeConditions(accountAddress, transactionTypes)
			: createMetaAddressesConditions(accountAddress);

		return this.queryTransactions(conditions, id, pageSize, { collectionName: 'partialTransactions', sortOrder: ordering });
	}

	// endregion

	// region account retrieval

	accountsByIds(ids) {
		// id will either have address property or publicKey property set; in the case of publicKey, convert it to address
		const buffers = ids.map(id => Buffer.from((id.publicKey
			? catapult.model.address.publicKeyToAddress(id.publicKey, this.networkId) : id.address)));
		return this.queryDocuments('accounts', { 'account.address': { $in: buffers } })
			.then(entities => entities.map(accountWithMetadata => {
				const { account } = accountWithMetadata;
				if (0 < account.importances.length) {
					const importanceSnapshot = account.importances.shift();
					account.importance = importanceSnapshot.value;
					account.importanceHeight = importanceSnapshot.height;
				} else {
					account.importance = convertToLong(0);
					account.importanceHeight = convertToLong(0);
				}

				delete account.importances;
				return accountWithMetadata;
			}));
	}

	// endregion

	// region cursor account helpers

	// Helper methods to add importance field.
	addFieldImportance() {
		return addFieldImportanceImpl('value');
	}

	// Helper methods to add importanceHeight field.
	addFieldImportanceHeight() {
		return addFieldImportanceImpl('height');
	}

	// Helper methods to add the harvestedBlocks field.
	addFieldHarvestedBlocks() {
		return { $size: "$account.activityBuckets" };
	}

	// Helper methods to add the harvestedFees field.
	addFieldHarvestedFees() {
		// Sum reduce over `totalFeesPaid` in `account.activityBuckets`.
		return {
			$reduce: {
				input: "$account.activityBuckets",
				initialValue: { $toLong: 0 },
				in: { $add: ["$$value", "$$this.totalFeesPaid"] }
 			}
		};
	}

	// Retrieve account by address with custom fields added and projected.
	rawAccountByAddress(collectionName, address, addFields, projection) {
		const aggregation = [
			{ $match: { 'account.address': { $eq: Buffer.from(address) } } },
			addFields
		];
		return this.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.project(projection)
			.limit(1)
			.toArray()
			.then(accounts => Promise.resolve(accounts[0]));
	}

	// Since the public key isn't unique for the network's private key,
	// and the calculation doesn't generate the right address,
	// this may not work for all data, but it's accurate for everything else.
	publicKeyToAddress(publicKey) {
		return address.publicKeyToAddress(publicKey, this.networkId);
	}

	// endregion

	// region cursor account by importance retrieval

	rawAccountWithImportanceByAddress(collectionName, address) {
		const addFields = { $addFields: {
			'account.importance': this.addFieldImportance(),
			'account.importanceHeight': this.addFieldImportanceHeight()
		} };
		const projection = { 'account.importances': 0 };
		return this.rawAccountByAddress(collectionName, address, addFields, projection);
	}

	rawAccountWithImportanceByPublicKey(collectionName, publicKey) {
		const address = this.publicKeyToAddress(publicKey);
		return this.rawAccountWithImportanceByAddress(collectionName, address);
	}

	// Internal method to find sorted accounts by importance from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedAccountsByImportance(collectionName, match, sortAscending, count) {
		const aggregation = [
			{ $addFields: {
				'account.importance': this.addFieldImportance(),
				'account.importanceHeight': this.addFieldImportanceHeight()
			} },
			{ $match: match }
		];
		// Need secondary public key height and ID height to sort by when the
		// account's public key was known to network.
		const projection = { 'account.importances': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'account.importance': order, 'account.publicKeyHeight': order, _id: order };
		const finalSort = { 'account.importance': -1, 'account.publicKeyHeight': -1, _id: -1 };

		return this.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	// Generate an account match condition from a field, an ordering,
	// and the publicKeyHeight and the object ID.
	accountMatchCondition(field, ordering, value, height, id) {
		// Match if the account field is less than the provided field
		// If the fields are equal, match if the height is less than the
		// public key height. If equal, match if the ID is less than the provided ID.
		return { $or: [
			{ [`account.${field}`]: { [ordering]: value } },
			{ $and: [
				{ [`account.${field}`]: { $eq: value } },
				{ $or: [
					{ 'meta.publicKeyHeight': { $eq: height }, _id: { [ordering]: id } },
					{ 'meta.publicKeyHeight': { [ordering]: height } }
				]},
			]},
		]};
	}

	// Internal method: get accounts up to (non-inclusive) the account with importance, height,
	// and ID, returning at max `numAccounts` items.
	accountsByImportanceFrom(collectionName, importance, height, id, numAccounts) {
		const match = this.accountMatchCondition('importance', '$lt', importance, height, id);
		return this.sortedAccountsByImportance(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// Internal method: get accounts since (non-inclusive) the account with importance, height,
	// and ID, returning at max `numAccounts` items.
	accountsByImportanceSince(collectionName, importance, height, id, numAccounts) {
		const match = this.accountMatchCondition('importance', '$gt', importance, height, id);
		return this.sortedAccountsByImportance(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region cursor account by harvested blocks retrieval

	rawAccountWithHarvestedBlocksByAddress(collectionName, address) {
		const addFields = { $addFields: {
			'account.importance': this.addFieldImportance(),
			'account.importanceHeight': this.addFieldImportanceHeight(),
			'account.harvestedBlocks': this.addFieldHarvestedBlocks()
		} };
		const projection = { 'account.importances': 0 };
		return this.rawAccountByAddress(collectionName, address, addFields, projection);
	}

	rawAccountWithHarvestedBlocksByPublicKey(collectionName, publicKey) {
		const address = this.publicKeyToAddress(publicKey);
		return this.rawAccountWithHarvestedBlocksByAddress(collectionName, address);
	}

	// Internal method to find sorted accounts by harvested blocks from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedAccountsByHarvestedBlocks(collectionName, match, sortAscending, count) {
		const aggregation = [
			{ $addFields: {
				'account.importance': this.addFieldImportance(),
				'account.importanceHeight': this.addFieldImportanceHeight(),
				'account.harvestedBlocks': this.addFieldHarvestedBlocks()
			} },
			{ $match: match }
		];
		// Need secondary public key height and ID height to sort by when the
		// account's public key was known to network.
		const projection = { 'account.importances': 0, 'account.harvestedBlocks': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'account.harvestedBlocks': order , 'account.publicKeyHeight': order , _id: order  };
		const finalSort = { 'account.harvestedBlocks': -1, 'account.publicKeyHeight': -1, _id: -1 };

		return this.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	// Internal method: get accounts up to (non-inclusive), returning at max `numAccounts` items.
	accountsByHarvestedBlocksFrom(collectionName, harvestedBlocks, height, id, numAccounts) {
		const match = this.accountMatchCondition('harvestedBlocks', '$lt', harvestedBlocks, height, id);
		return this.sortedAccountsByHarvestedBlocks(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// Internal method: get accounts since (non-inclusive), returning at max `numAccounts` items.
	accountsByHarvestedBlocksSince(collectionName, harvestedBlocks, height, id, numAccounts) {
		const match = this.accountMatchCondition('harvestedBlocks', '$gt', harvestedBlocks, height, id);
		return this.sortedAccountsByHarvestedBlocks(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region cursor account by harvested fees retrieval

	rawAccountWithHarvestedFeesByAddress(collectionName, address) {
		const addFields = { $addFields: {
			'account.importance': this.addFieldImportance(),
			'account.importanceHeight': this.addFieldImportanceHeight(),
			'account.harvestedBlocks': this.addFieldHarvestedBlocks(),
			'account.harvestedFees': this.addFieldHarvestedFees()
		} };
		const projection = { 'account.importances': 0, 'account.harvestedBlocks': 0 };
		return this.rawAccountByAddress(collectionName, address, addFields, projection);
	}

	rawAccountWithHarvestedFeesByPublicKey(collectionName, publicKey) {
		const address = this.publicKeyToAddress(publicKey);
		return this.rawAccountWithHarvestedFeesByAddress(collectionName, address);
	}

	// Internal method to find sorted accounts by harvested fees from query.
	// Note:
	//	Use an initial sort to ensure we limit in the desired order,
	//	then use a final sort to ensure everything is in descending order.
	sortedAccountsByHarvestedFees(collectionName, match, sortAscending, count) {
		const aggregation = [
			{ $addFields: {
				'account.importance': this.addFieldImportance(),
				'account.importanceHeight': this.addFieldImportanceHeight(),
				'account.harvestedBlocks': this.addFieldHarvestedBlocks(),
				'account.harvestedFees': this.addFieldHarvestedFees()
			} },
			{ $match: match }
		];
		// Sort by harvested blocks after to break ties: more attempted harvested,
		// should score higher.
		// Need secondary public key height and ID height to sort by when the
		// account's public key was known to network.
		const projection = { 'account.importances': 0, 'account.harvestedBlocks': 0, 'account.harvestedFees': 0 };
		const order = sortAscending ? 1 : -1;
		const initialSort = { 'account.harvestedFees': order, 'account.harvestedBlocks': order, 'account.publicKeyHeight': order, _id: order };
		const finalSort = { 'account.harvestedFees': -1, 'account.harvestedBlocks': -1, 'account.publicKeyHeight': -1, _id: -1 };

		return this.database.collection(collectionName)
			.aggregate(aggregation, { promoteLongs: false })
			.sort(initialSort)
			.limit(count)
			.sort(finalSort)
			.project(projection)
			.toArray()
			.then(this.sanitizer.deleteIds);
	}

	// Internal method: get accounts up to (non-inclusive), returning at max `numAccounts` items.
	accountsByHarvestedFeesFrom(collectionName, harvestedFees, height, id, numAccounts) {
		const match = this.accountMatchCondition('harvestedFees', '$lt', harvestedFees, height, id);
		return this.sortedAccountsByHarvestedFees(collectionName, match, false, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// Internal method: get accounts since (non-inclusive), returning at max `numAccounts` items.
	accountsByHarvestedFeesSince(collectionName, harvestedFees, height, id, numAccounts) {
		const match = this.accountMatchCondition('harvestedFees', '$gt', harvestedFees, height, id);
		return this.sortedAccountsByHarvestedFees(collectionName, match, true, numAccounts)
			.then(accounts => Promise.resolve(accounts));
	}

	// endregion

	// region failed transaction

	/**
	 * Retrieves transaction results for the given hashes.
	 * @param {Array.<Uint8Array>} hashes Transaction hashes.
	 * @returns {Promise.<Array>} Promise that resolves to the array of hash / validation result pairs.
	 */
	transactionsByHashesFailed(hashes) {
		const buffers = hashes.map(hash => Buffer.from(hash));
		return this.queryDocuments('transactionStatuses', { 'status.hash': { $in: buffers } });
	}

	// endregion

	// region utils

	/**
	 * Retrieves account publickey projection for the given address.
	 * @param {Uint8Array} accountAddress Account address.
	 * @returns {Promise<Buffer>} Promise that resolves to the account public key.
	 */
	addressToPublicKey(accountAddress) {
		const conditions = { 'account.address': Buffer.from(accountAddress) };
		const projection = { 'account.publicKey': 1 };
		return this.queryDocument('accounts', conditions, projection);
	}

	// endregion
}

module.exports = CatapultDb;
