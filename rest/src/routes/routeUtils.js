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
const routeResultTypes = require('./routeResultTypes');
const errors = require('../server/errors');
const catapult = require('catapult-sdk');
const MongoDb = require('mongodb');

const { Long } = MongoDb;
const { address } = catapult.model;
const { buildAuditPath, indexOfLeafWithHash } = catapult.crypto.merkle;
const { convert, uint64 } = catapult.utils;
const packetHeader = catapult.packet.header;
const constants = {
	sizes: {
		hexPublicKey: 64,
		addressEncoded: 39,
		addressEncoded: 40,
		hexAddress: 50,
		hexHash256: 64,
		hash256: 32,
		hexHash512: 128,
		hash512: 64,
		hexObjectId: 24,
		hexNamespaceId: 16,
		hexMosaicId: 16
	}
};

const isObjectId = str => 24 === str.length && convert.isHexString(str);

/**
 * Parses a decimal string into a uint64.
 * @param {string} input A decimal encoded string.
 * @returns {module:utils/uint64~uint64} Uint64 representation of the input.
 */
const uint64FromString = input => {
	const long = Long.fromString(input);
  const low = long.getLowBitsUnsigned();
  let high = long.getHighBits();
  if (high < 0) {
      // Signed 32-bit integer, convert to unsigned.
      high += 2**32;
  }

  return [low, high];
};

const namedValidatorMap = {
	objectId: str => constants.sizes.hexObjectId === str.length && convert.isHexString(str),
	namespaceId: str => constants.sizes.hexNamespaceId === str.length && convert.isHexString(str),
	mosaicId: str => constants.sizes.hexMosaicId === str.length && convert.isHexString(str),
	integer: str => /^\d+$/.test(str),
	address: str => constants.sizes.addressEncoded === str.length || constants.sizes.hexAddress === str.length,
	publicKey: str => constants.sizes.hexPublicKey === str.length,
	hash256: str => constants.sizes.hexHash256 === str.length,
	hash512: str => constants.sizes.hexHash512 === str.length,
	earliest: str => str === 'earliest' || str === 'min',
	latest: str => str === 'latest' || str === 'max',
	least: str => str === 'least' || str === 'min',
	most: str => str === 'most' || str === 'max',
	duration: str => str === 'from' || str === 'since',
	transferFilterType: str => str === 'mosaic' || str === 'multisig'
};

const namedParserMap = {
	objectId: str => {
		if (!isObjectId(str))
			throw Error('must be 12-byte hex string');

		return str;
	},
	namespaceId: str => {
		if (!namedValidatorMap.namespaceId(str))
			throw Error('must be 8-byte hex string');

		return uint64.fromHex(str);
	},
	mosaicId: str => {
		if (!namedValidatorMap.mosaicId(str))
			throw Error('must be 8-byte hex string');

		return uint64.fromHex(str);
	},
	uint: str => {
		const result = convert.tryParseUint(str);
		if (undefined === result)
			throw Error('must be non-negative number');

		return result;
	},
	uint64: str => uint64.fromString(str),
	uint64hex: str => uint64.fromHex(str),
	uint64: str => {
		return uint64FromString(str);
	},
	address: str => {
		if (constants.sizes.addressEncoded === str.length)
			return address.stringToAddress(str);
		if (constants.sizes.hexAddress === str.length)
			return convert.hexToUint8(str);

		throw Error(`invalid length of address '${str.length}'`);
	},
	publicKey: str => {
		if (constants.sizes.hexPublicKey === str.length)
			return convert.hexToUint8(str);

		throw Error(`invalid length of publicKey '${str.length}'`);
	},
	accountId: str => {
		if (constants.sizes.hexPublicKey === str.length)
			return ['publicKey', convert.hexToUint8(str)];
		if (constants.sizes.addressEncoded === str.length)
			return ['address', address.stringToAddress(str)];

		throw Error(`invalid length of account id '${str.length}'`);
	},
	hash256: str => {
		if (2 * constants.sizes.hash256 === str.length)
			return convert.hexToUint8(str);

		throw Error(`invalid length of hash256 '${str.length}'`);
	},
	hash512: str => {
		if (2 * constants.sizes.hash512 === str.length)
			return convert.hexToUint8(str);

		throw Error(`invalid length of hash512 '${str.length}'`);
	},
	boolean: str => {
		if (('true' !== str) && ('false' !== str))
			throw Error('must be boolean value \'true\' or \'false\'');

		return 'true' === str;
    },
	duration: str => {
		if (!namedValidatorMap.duration(str))
			throw Error('invalid duration specifier');

		return str;
	},
	transactionType: str => {
		const type = catapult.model.EntityType[str];
		if (undefined === type)
			throw Error('unrecognized transaction type');

		return type;
	},
	transferFilterType: str => {
		if (namedValidatorMap.transferFilterType(str))
			return str;
		throw Error(`invalid transfer filter type ${str}`)
	}
};

const getBoundedPageSize = (pageSize, optionsPageSize) =>
	Math.max(optionsPageSize.min, Math.min(optionsPageSize.max, pageSize || optionsPageSize.default));

const isPage = page => undefined !== page.data && undefined !== page.pagination.totalEntries && undefined !== page.pagination.pageNumber
	&& undefined !== page.pagination.pageSize && undefined !== page.pagination.totalPages;

const routeUtils = {
	/**
	 * Parses an argument and throws an invalid argument error if it is invalid.
	 * @param {object} args Container containing the argument to parse.
	 * @param {string} key Name of the argument to parse.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 * @returns {object} Parsed value.
	 */
	parseArgument: (args, key, parser) => {
		try {
			return ('string' === typeof parser ? namedParserMap[parser] : parser)(args[key]);
		} catch (err) {
			throw errors.createInvalidArgumentError(`${key} has an invalid format`, err);
		}
	},

	/**
	 * Parses a range argument and throws an invalid argument error if it is invalid.
	 * @param {object} args Container containing the argument to parse.
	 * @param {string} key Name of the argument to parse.
	 * @param {object} range Range of valid values.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 * @returns {object} Parsed value.
	 */
	parseRangeArgument(args, key, range, parser) {
		try {
			return this.parseRangeValue(args[key], range, parser);
		} catch (err) {
			throw errors.createInvalidArgumentError(`${key} has an invalid format`, err);
		}
	},

	/**
	 * Parses a value.
	 * @param {any} str Value to parse.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 * @returns {object} Parsed value.
	 */
	parseValue: (str, parser) => {
		return ('string' === typeof parser ? namedParserMap[parser] : parser)(str);
	},

	/**
	 * Parses a value with valid, acceptable range values.
	 * @param {any} str Value to parse.
	 * @param {object} range Range of valid values.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 * @returns {object} Parsed value or undefined.
	 */
	parseRangeValue(str, range, parser) {
		const value = this.parseValue(str, parser);
		if (value < range.min)
			return undefined;
		if (value > range.max)
			return undefined;
		return value;
	},

	/**
	 * Validates a value to parse.
	 * @param {any} value Value to validate.
	 * @param {Function|string} validator Validator to use or the name of a named validator.
	 * @returns {object} Whether value is valid.
	 */
	validateValue: (value, validator) => {
		return ('string' === typeof validator ? namedValidatorMap[validator] : validator)(value);
	},

	/**
	 * Parses an argument as an array and throws an invalid argument error if any element is invalid.
	 * @param {object} args Container containing the argument to parse.
	 * @param {string} key Name of the argument to parse.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 * @returns {object} Array with parsed values.
	 */
	parseArgumentAsArray: (args, key, parser) => {
		const realParser = 'string' === typeof parser ? namedParserMap[parser] : parser;
		let providedArgs = args[key];
		if (!Array.isArray(providedArgs))
			providedArgs = [providedArgs];

		try {
			return providedArgs.map(realParser);
		} catch (err) {
			throw errors.createInvalidArgumentError(`element in array ${key} has an invalid format`, err);
		}
	},

	/**
	 * Parses optional paging arguments and throws an invalid argument error if any is invalid.
	 * @param {object} args Arguments to parse.
	 * @returns {object} Parsed paging options.
	 */
	parsePagingArguments: args => {
		const parsedOptions = { id: undefined, pageSize: 0 };
		const parsers = {
			id: { tryParse: str => (isObjectId(str) ? str : undefined), type: 'object id' },
			pageSize: { tryParse: convert.tryParseUint, type: 'unsigned integer' }
		};

		Object.keys(parsedOptions).filter(key => args[key]).forEach(key => {
			const parser = parsers[key];
			parsedOptions[key] = parser.tryParse(args[key]);
			if (!parsedOptions[key])
				throw errors.createInvalidArgumentError(`${key} is not a valid ${parser.type}`);
		});

		return parsedOptions;
	},

	/**
	 * Parses pagination arguments and throws an invalid argument error if any is invalid.
	 * @param {object} args Arguments to parse.
	 * @param {object} optionsPageSize Page size options.
	 * @param {object} offsetParsers Sort fields with the related offset parser this endpoint allows, will match provided `sortField` and
	 * throw if invalid. Must have at least one entry, and `id` is treated as default if no `sortField` is provided.
	 * @returns {object} Parsed pagination options.
	 */
	parsePaginationArguments: (args, optionsPageSize, offsetParsers) => {
		const allowedSortFields = Object.keys(offsetParsers);
		if (args.orderBy && !allowedSortFields.includes(args.orderBy))
			throw errors.createInvalidArgumentError(`sorting by ${args.orderBy} is not allowed`);

		const parsedArgs = {
			sortField: allowedSortFields.includes(args.orderBy) ? args.orderBy : 'id',
			sortDirection: 'desc' === args.order ? -1 : 1
		};

		if (args.pageSize) {
			const numericPageSize = convert.tryParseUint(args.pageSize);
			if (undefined === numericPageSize)
				throw errors.createInvalidArgumentError('pageSize is not a valid unsigned integer');

			parsedArgs.pageSize = getBoundedPageSize(numericPageSize, optionsPageSize);
		} else {
			parsedArgs.pageSize = optionsPageSize.default;
		}

		if (args.pageNumber) {
			const numericPageNumber = convert.tryParseUint(args.pageNumber);
			if (undefined === numericPageNumber)
				throw errors.createInvalidArgumentError('pageNumber is not a valid unsigned integer');

			parsedArgs.pageNumber = numericPageNumber;
		}
		parsedArgs.pageNumber = 0 < parsedArgs.pageNumber ? parsedArgs.pageNumber : 1;

		if (args.offset)
			parsedArgs.offset = routeUtils.parseArgument(args, 'offset', offsetParsers[parsedArgs.sortField]);

		return parsedArgs;
	},

	/**
	 * Creates a sender for forwarding one or more objects of a given type.
	 * @param {module:routes/routeResultTypes} type Object type.
	 * @returns {object} Sender.
	 */
	createSender: type => ({
		/**
		 * Creates an array handler that forwards an array.
		 * @param {object} id Array identifier.
		 * @param {object} res Restify response object.
		 * @param {Function} next Restify next callback handler.
		 * @returns {Function} An appropriate array handler.
		 */
		sendArray(id, res, next) {
			return array => {
				if (!Array.isArray(array))
					res.send(errors.createInternalError(`error retrieving data for id: '${id}'`));
				else
					res.send({ payload: array, type });

				next();
			};
		},

		/**
		 * Creates an object handler that either forwards an object corresponding to an identifier
		 * or sends a not found error if no such object exists.
		 * @param {object} id Object identifier.
		 * @param {object} res Restify response object.
		 * @param {Function} next Restify next callback handler.
		 * @returns {Function} An appropriate object handler.
		 */
		sendOne(id, res, next) {
			const sendOneObject = object => {
				if (!object)
					res.send(errors.createNotFoundError(id));
				else
					res.send({ payload: object, type });
			};

			return object => {
				if (Array.isArray(object)) {
					if (2 <= object.length)
						res.send(errors.createInternalError(`error retrieving data for id: '${id}' (length ${object.length})`));
					else
						sendOneObject(object.length && object[0]);
				} else {
					sendOneObject(object);
				}

				next();
			};
		},

		/**
		 * Creates a page handler that forwards a paginated result.
		 * @param {object} res Restify response object.
		 * @param {Function} next Restify next callback handler.
		 * @returns {Function} An appropriate object handler.
		 */
		sendPage(res, next) {
			return page => {
				if (!isPage(page))
					res.send(errors.createInternalError('error retrieving data'));
				else
					res.send({ payload: page, type, structure: 'page' });
				next();
			};
		}
	}),

	/**
	 * Query and send duration collection to network.
	 *
	 *	@param {object} info Information to create and send query.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} identifier Identifier for query for error handling.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} method Name of timeline method to call.
	 *		@field {array} args Arguments to timeline method.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	queryAndSendTimeline: info => {
		info.timeline[info.method](...info.args)
			.then(data => {
				if (data === undefined) {
					info.response.send(errors.createNotFoundError(info.identifier));
					return info.next();
				}

				info.response.send({
					payload: data.map(info.transformer),
					type: info.resultType
				});
				info.next();
			});
	},

	/**
	 *	Method to get account timelines from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getAccountTimeline(info) {
		const params = info.request.params;
		const account = params.account;
		const limit = routeUtils.parseRangeArgument(params, 'limit', info.countRange, 'uint');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (routeUtils.validateValue(account, 'least')) {
			method = info.duration + 'Min';
			args = [info.collectionName, limit];
		} else if (routeUtils.validateValue(account, 'most')) {
			method = info.duration + 'Max';
			args = [info.collectionName, limit];
		} else if (routeUtils.validateValue(account, 'address')) {
			method = info.duration + 'Address';
			const address = routeUtils.parseValue(account, 'address');
			args = [info.collectionName, address, limit];
		} else if (routeUtils.validateValue(account, 'publicKey')) {
			method = info.duration + 'PublicKey';
			const publicKey = routeUtils.parseValue(account, 'publicKey');
			args = [info.collectionName, publicKey, limit];
		} else {
			const error = errors.createInvalidArgumentError('accountId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: account,
			method,
			args
		});
	},

	/**
	 *	Method to get block timelines from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getBlockTimeline(info) {
		const params = info.request.params;
		const block = params.block;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(block, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, limit];
		} else if (this.validateValue(block, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, limit];
		} else if (this.validateValue(block, 'hash256')) {
			method = info.duration + 'Hash';
			const hash = this.parseValue(block, 'hash256');
			args = [info.collectionName, hash, limit];
		} else if (this.validateValue(block, 'integer')) {
			method = info.duration + 'Height';
			const height = this.parseValue(block, 'uint64');
			args = [info.collectionName, height, limit];
		} else {
			const error = errors.createInvalidArgumentError('blockId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: block,
			method,
			args
		});
	},

	/**
	 *	Method to get mosaic timelines from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getMosaicTimeline(info) {
		const params = info.request.params;
		const mosaic = params.mosaic;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(mosaic, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, limit];
		} else if (this.validateValue(mosaic, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, limit];
		} else if (this.validateValue(mosaic, 'mosaicId')) {
			method = info.duration + 'Id';
			const id = this.parseValue(mosaic, 'mosaicId');
			args = [info.collectionName, id, limit];
		} else {
			const error = errors.createInvalidArgumentError('mosaicId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: mosaic,
			method,
			args
		});
	},

	/**
	 *	Method to get namespace timelines from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getNamespaceTimeline(info) {
		const params = info.request.params;
		const namespace = params.namespace;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(namespace, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, limit];
		} else if (this.validateValue(namespace, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, limit];
		} else if (this.validateValue(namespace, 'namespaceId')) {
			method = info.duration + 'Id';
			const id = this.parseValue(namespace, 'namespaceId');
			args = [info.collectionName, id, limit];
	  } else if (this.validateValue(namespace, 'objectId')) {
			method = info.duration + 'ObjectId';
			const id = this.parseValue(namespace, 'objectId');
			args = [info.collectionName, id, limit];
		} else {
			const error = errors.createInvalidArgumentError('namespaceId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: namespace,
			method,
			args
		});
	},

	/**
	 *	Method to get transaction timelines from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getTransactionTimeline(info) {
		const params = info.request.params;
		const transaction = params.transaction;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(transaction, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, limit];
		} else if (this.validateValue(transaction, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, limit];
		} else if (this.validateValue(transaction, 'objectId')) {
			method = info.duration + 'Id';
			const id = this.parseValue(transaction, 'objectId');
			args = [info.collectionName, id, limit];
		} else if (this.validateValue(transaction, 'hash256')) {
			method = info.duration + 'Hash';
			const hash = this.parseValue(transaction, 'hash256');
			args = [info.collectionName, hash, limit];
		} else {
			const error = errors.createInvalidArgumentError('transactionId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: transaction,
			method,
			args
		});
	},

	/**
	 *	Method to get transaction timelines filtered by type from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getTransactionByTypeTimeline(info) {
		const params = info.request.params;
		const transaction = params.transaction;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');
		const type = this.parseArgument(params, 'type', 'transactionType');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(transaction, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, type, limit];
		} else if (this.validateValue(transaction, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, type, limit];
		} else if (this.validateValue(transaction, 'objectId')) {
			method = info.duration + 'Id';
			const id = this.parseValue(transaction, 'objectId');
			args = [info.collectionName, id, type, limit];
		} else if (this.validateValue(transaction, 'hash256')) {
			method = info.duration + 'Hash';
			const hash = this.parseValue(transaction, 'hash256');
			args = [info.collectionName, hash, type, limit];
		} else {
			const error = errors.createInvalidArgumentError('transactionId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: transaction,
			method,
			args
		});
	},

	/**
	 *	Method to get transaction timelines filtered by type and a subfilter from a duration and argument.
	 *
	 *	@param {object} info Information to fetch timeline from database.
	 *		@field {object} request Restify request object.
	 *		@field {object} response Restify response object.
	 *		@field {Function} next Restify next callback handler.
	 *		@field {object} timeline Timeline utility.
	 *		@field {string} collectionName Name of the collection to query.
	 *		@field {object} countRange Range of valid query counts.
	 *		@field {Function} redirectUrl Callback to get redirect URL.
	 *		@field {string} duration Duration specifier: 'from' or 'since'.
	 *		@field {Function} transformer Callback to transform returned data prior to sending.
	 *		@field {string} resultType Response data type.
	 */
	getTransactionByTypeWithFilterTimeline(info) {
		const params = info.request.params;
		const transaction = params.transaction;
		const limit = this.parseRangeArgument(params, 'limit', info.countRange, 'uint');
		const type = this.parseArgument(params, 'type', 'transactionType');
		// params.type has already been white-listed, so this is safe.
		const filter = this.parseArgument(params, 'filter', params.type + 'FilterType');

		if (!limit) {
			const url = info.redirectUrl(info.countRange.preset);
			return info.response.redirect(url, info.next);
		}

		let method;
		let args;
		if (this.validateValue(transaction, 'earliest')) {
			method = info.duration + 'Min';
			args = [info.collectionName, type, filter, limit];
		} else if (this.validateValue(transaction, 'latest')) {
			method = info.duration + 'Max';
			args = [info.collectionName, type, filter, limit];
		} else if (this.validateValue(transaction, 'objectId')) {
			method = info.duration + 'Id';
			const id = this.parseValue(transaction, 'objectId');
			args = [info.collectionName, id, type, filter, limit];
		} else if (this.validateValue(transaction, 'hash256')) {
			method = info.duration + 'Hash';
			const hash = this.parseValue(transaction, 'hash256');
			args = [info.collectionName, hash, type, filter, limit];
		} else {
			const error = errors.createInvalidArgumentError('transactionId has an invalid format');
			info.response.send(error);
			return info.next();
		}

		this.queryAndSendTimeline({
			response: info.response,
			next: info.next,
			timeline: info.timeline,
			transformer: info.transformer,
			resultType: info.resultType,
			identifier: transaction,
			method,
			args
		});
	},

	/**
	 * Adds GET and POST routes for looking up documents of a single type.
	 * @param {object} server Server on which to register the routes.
	 * @param {object} sender Sender to use for sending the results.
	 * @param {object} routeInfo Information about the routes.
	 * @param {Function} documentRetriever Lookup function for retrieving the documents.
	 * @param {Function|string} parser Parser to use or the name of a named parser.
	 */
	addGetPostDocumentRoutes: (server, sender, routeInfo, documentRetriever, parser) => {
		const routes = {
			get: `${routeInfo.base}/:${routeInfo.singular}`,
			post: `${routeInfo.base}`
		};
		if (routeInfo.postfixes) {
			routes.get += `/${routeInfo.postfixes.singular}`;
			routes.post += `/${routeInfo.postfixes.plural}`;
		}

		server.get(routes.get, (req, res, next) => {
			const key = routeUtils.parseArgument(req.params, routeInfo.singular, parser);
			return documentRetriever([key]).then(sender.sendOne(req.params[routeInfo.singular], res, next));
		});

		server.post(routes.post, (req, res, next) => {
			const keys = routeUtils.parseArgumentAsArray(req.params, routeInfo.plural, parser);
			return documentRetriever(keys).then(sender.sendArray(req.params[routeInfo.plural], res, next));
		});
	},

	/**
	 * Adds PUT route for sending a packet to an api server.
 	 * @param {object} server Server on which to register the routes.
 	 * @param {object} connections Api server connection pool.
	 * @param {object} routeInfo Information about the route.
	 * @param {Function} parser Parser to use to parse the route parameters into a packet payload.
	 */
	addPutPacketRoute: (server, connections, routeInfo, parser) => {
		const createPacketFromBuffer = (data, packetType) => {
			const length = packetHeader.size + data.length;
			const header = packetHeader.createBuffer(packetType, length);
			const buffers = [header, Buffer.from(data)];
			return Buffer.concat(buffers, length);
		};

		server.put(routeInfo.routeName, (req, res, next) => {
			const packetBuffer = createPacketFromBuffer(parser(req.params), routeInfo.packetType);
			return connections.lease()
				.then(connection => connection.send(packetBuffer))
				.then(() => {
					res.send(202, { message: `packet ${routeInfo.packetType} was pushed to the network via ${routeInfo.routeName}` });
					next();
				});
		});
	},

	/**
	 * Returns function for processing merkle tree path requests.
	 * @param {module:db/CatapultDb} db Catapult database.
	 * @param {string} blockMetaCountField Field name for block meta count.
	 * @param {string} blockMetaTreeField Field name for block meta merkle tree.
	 * @returns {Function} Restify response function to process merkle path requests.
	 */
	blockRouteMerkleProcessor: (db, blockMetaCountField, blockMetaTreeField) => (req, res, next) => {
		const height = routeUtils.parseArgument(req.params, 'height', 'uint');
		const hash = routeUtils.parseArgument(req.params, 'hash', 'hash256');

		return dbFacade.runHeightDependentOperation(db, height, () => db.blockWithMerkleTreeAtHeight(height, blockMetaTreeField))
			.then(result => {
				if (!result.isRequestValid) {
					res.send(errors.createNotFoundError(height));
					return next();
				}

				const block = result.payload;
				if (!block.meta[blockMetaCountField]) {
					res.send(errors.createInvalidArgumentError(`hash '${req.params.hash}' not included in block height '${height}'`));
					return next();
				}

				const merkleTree = {
					count: block.meta[blockMetaCountField],
					nodes: block.meta[blockMetaTreeField].map(merkleHash => merkleHash.buffer)
				};

				if (0 > indexOfLeafWithHash(hash, merkleTree)) {
					res.send(errors.createInvalidArgumentError(`hash '${req.params.hash}' not included in block height '${height}'`));
					return next();
				}

				const merklePath = buildAuditPath(hash, merkleTree);

				res.send({
					payload: { merklePath },
					type: routeResultTypes.merkleProofInfo
				});

				return next();
			});
	},

	/**
	 * Returns account public key from account address .
	 * @param {module:db/CatapultDb} db Catapult database.
	 * @param {Uint8Array} accountAddress Account address.
	 * @returns {Promise<Uint8Array>} Account public key.
	 */
	addressToPublicKey: (db, accountAddress) => db.addressToPublicKey(accountAddress)
		.then(result => {
			if (!result)
				return Promise.reject(Error('account not found'));

			return result.account.publicKey.buffer;
		})
};

module.exports = routeUtils;
