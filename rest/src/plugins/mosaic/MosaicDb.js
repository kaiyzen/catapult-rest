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

const AccountType = require('../AccountType');
const Timeline = require('../../db/Timeline');
const MongoDb = require('mongodb');

const { Long } = MongoDb;

class MosaicDb {
	/**
	 * Creates MosaicDb around CatapultDb.
	 * @param {module:db/CatapultDb} db Catapult db instance.
	 */
	constructor(db) {
		this.catapultDb = db;

    // Mosaic timeline.
    const mosaicMinArgs = () => [Timeline.minLong(), Timeline.minObjectId()];
    const mosaicMaxArgs = () => [Timeline.maxLong(), Timeline.maxObjectId()];
    const mosaicToArgs = (mosaic) => [mosaic.mosaic.startHeight, mosaic._id];
    this.mosaicTimeline = new Timeline({
      database: this,
      ...Timeline.generateAbsoluteParameters({
        baseMethodName: 'mosaics',
        generateMinArgs: mosaicMinArgs,
        generateMaxArgs: mosaicMaxArgs
      }),
      ...Timeline.generateIdParameters({
        keyName: 'Id',
        baseMethodName: 'mosaics',
        idMethodName: 'rawMosaicById',
        generateArgs: mosaicToArgs
      })
    });
	}

  // region raw mosaic retrieval

  // Internal method: retrieve mosaic by ID.
  // Does not process internal _id.
  rawMosaicById(collectionName, id) {
    const mosaicId = new Long(id[0], id[1]);
    const condition = { 'mosaic.id': { $eq: mosaicId } };
    return this.catapultDb.queryDocument(collectionName, condition);
  }

  // endregion

  // region cursor mosaic retrieval

	// Internal method to find sorted mosaics from query.
  // Note:
  //  Use an initial sort to ensure we limit in the desired order,
  //  then use a final sort to ensure everything is in descending order.
	sortedMosaics(collectionName, condition, sortAscending, count) {
		// Sort by descending startHeight, then by descending ID.
		// Don't sort solely on ID, since it will break if 32-bit time wraps.
    const order = sortAscending ? 1 : -1;
    const initialSort = { 'mosaic.startHeight': order, _id: order };
		const finalSort = { 'mosaic.startHeight': -1, _id: -1 };
    return this.catapultDb.database.collection(collectionName)
      .find(condition)
      .sort(initialSort)
      .limit(count)
      .sort(finalSort)
      .toArray()
			.then(this.catapultDb.sanitizer.deleteIds);
	}

	// Internal method to get mosaics up to (non-inclusive) the block height
	// and the mosaic ID, returning at max `count` items.
	mosaicsFrom(collectionName, height, id, count) {
		const condition = { $or: [
			{ 'mosaic.startHeight': { $eq: height }, _id: { $lt: id } },
			{ 'mosaic.startHeight': { $lt: height } }
		]};

		return this.sortedMosaics(collectionName, condition, false, count)
			.then(mosaics => Promise.resolve(mosaics));
	}

	// Internal method to get mosaics since (non-inclusive) the block height
	// and the mosaic ID, returning at max `count` items.
	mosaicsSince(collectionName, height, id, count) {
		const condition = { $or: [
			{ 'mosaic.startHeight': { $eq: height }, _id: { $gt: id } },
			{ 'mosaic.startHeight': { $gt: height } }
		]};

		return this.sortedMosaics(collectionName, condition, true, count)
			.then(mosaics => Promise.resolve(mosaics));
	}

  // endregion

  // region mosaic retrieval

	/**
	 * Retrieves mosaics.
	 * @param {Array.<module:catapult.utils/uint64~uint64>} ids Mosaic ids.
	 * @returns {Promise.<array>} Mosaics.
	 */
	mosaicsByIds(ids) {
		const mosaicIds = ids.map(id => new Long(id[0], id[1]));
		const conditions = { 'mosaic.id': { $in: mosaicIds } };
		const collection = this.catapultDb.database.collection('mosaics');
		return collection.find(conditions)
			.sort({ _id: -1 })
			.toArray()
			.then(entities => Promise.resolve(this.catapultDb.sanitizer.deleteIds(entities)));
	}

	/**
	 * Retrieves mosaics owned by specified owners.
	 * @param {module:db/AccountType} type Type of account ids.
	 * @param {array<object>} accountIds Account ids.
	 * @returns {Promise.<array>} Owned mosaics.
	 */
	mosaicsByOwners(type, accountIds) {
		const buffers = accountIds.map(accountId => Buffer.from(accountId));
		const fieldName = (AccountType.publicKey === type) ? 'mosaic.ownerPublicKey' : 'mosaic.ownerAddress';
		const conditions = { [fieldName]: { $in: buffers } };

		return this.catapultDb.queryDocuments('mosaics', conditions)
			.then(mosaics => mosaics.map(mosaic => mosaic.mosaic));
	}

	// endregion
}

module.exports = MosaicDb;
