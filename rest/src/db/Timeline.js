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

/** @module db/Timeline */

const MongoDb = require('mongodb');

const { Long, ObjectId } = MongoDb;

// Timeline class that creates the methods to carry out all timeline
// requests from configuration options.
//
//  options - Options for generating the bound methods.
//    Each method should have a callback type, and the parameters for that
//    callback. The keys will be bound as method names for the timeline,
//    and the values will be used to construct a callback.
class Timeline {
  // region sentinel values

  // Get the minimum signed value for a long.
  static minLong() {
    return new Long(0, 0);
  }

  // Get the maximum signed value for a long.
  static maxLong() {
    return new Long(0XFFFFFFFF, 0X7FFFFFFF);
  }

  // Get the minimum object ID value.
  static minObjectId() {
    return new ObjectId('000000000000000000000000');
  }

  // Get the maximum object ID value.
  static maxObjectId() {
    return new ObjectId('FFFFFFFFFFFFFFFFFFFFFFFF');
  }

  // endregion

  // region callback generators

  // Function to generate the parameters for the absolute methods.
  //    These methods query from an absolute value (max, min), and then
  //    query the database from that position.
  static generateAbsoluteParameters(info) {
    return {
      fromMin: {
        type: 'empty'
      },
      fromMax: {
        type: 'absolute',
        methodName: info.baseMethodName + 'From',
        generateArgs: info.generateMaxArgs
      },
      sinceMin: {
        type: 'absolute',
        methodName: info.baseMethodName + 'Since',
        generateArgs: info.generateMinArgs
      },
      sinceMax: {
        type: 'empty'
      }
    }
  }

  // Helper to generate the parameters for the ID-based methods.
  //    These methods require an ID lookup, and then query the database
  //    from that value.
  static generateIdParameters(info) {
    return {
      ['from' + info.keyName]: {
        type: 'identifier',
        idMethodName: info.idMethodName,
        methodName: info.baseMethodName + 'From',
        generateArgs: info.generateArgs
      },
      ['since' + info.keyName]: {
        type: 'identifier',
        idMethodName: info.idMethodName,
        methodName: info.baseMethodName + 'Since',
        generateArgs: info.generateArgs
      }
    }
  }

  // endregion

  // region query types

  // Get 0 records as a promise.
  static empty(info) {
    return Promise.resolve([]);
  }

  // Get the N records relative (and including) an absolute duration.
  //
  //  info - Structure containing internal method parameters.
  //    methodName - Name of the method to call on the database.
  //    collectionName - Name of the collection to query.
  //    generateArgs - Callback to generate initial args for the method.
  //    args - Rest-style args for the method.
  static absolute(info) {
    // Count is always provided as the last argument.
    // If count is 0, always resolves to an empty array.
    if (0 === info.args[info.args.length - 1])
      return Timeline.empty();

    return info.database[info.methodName](
      info.collectionName,
      ...info.generateArgs(),
      ...info.args
    );
  };

  // Get records relative to (non-inclusive) a provided record.
  //
  //  info - Structure containing internal method parameters.
  //    methodName - Name of the method to call on the database.
  //    collectionName - Name of the collection to query.
  //    record - Record to signal start position for query.
  //    generateArgs - Callback to generate initial args for the method.
  //    args - Rest-style args for the method.
  static record(info) {
    // If no record was provided, we have an undefined result from a query,
    // which we want to propagate.
    if (undefined === info.record)
      return undefined;

    // Count is always provided as the last argument.
    // If count is 0, always resolves to an empty array.
    if (0 === info.args[info.args.length - 1])
      return Timeline.empty();

    return info.database[info.methodName](
      info.collectionName,
      ...info.generateArgs(info.record),
      ...info.args
    );
  };

  // Get records relative to (non-inclusive) a record looked up by an ID.
  //
  //  info - Structure containing internal method parameters.
  //    collectionName - Name of the collection to query.
  //    idMethodName - Name of method to lookup record from ID.
  //    args - Rest-style args for the array method.
  static identifier(info) {
    const [id, ...args] = info.args;
    return info.database[info.idMethodName](info.collectionName, id)
      .then(record => Timeline.record({
        record,
        ...info,
        args
      }));
  };

  // endregion

  // Bind the database and the methods to the class.
  constructor(options) {
    this.database = options.database;
    delete options.database;

    // Dynamically bind the methods to the class.
    for (let [key, value] of Object.entries(options)) {
      this[key] = (collectionName, ...args) => {
        return Timeline[value.type]({
          database: this.database,
          collectionName,
          args,
          ...value
        });
      };
    }
  }
};

module.exports = Timeline;
