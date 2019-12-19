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

/** @module sockets/nodePeersCodec */
const nodeInfoCodec = require('./nodeInfoCodec');
const catapult = require('catapult-sdk');

const { sizes } = catapult.constants;

const uint8Size = 1
const uint16Size = 2
const uint32Size = 4
const minInfoSize = uint32Size + sizes.signerPublicKey + uint32Size + uint16Size + (3 * uint8Size);

const nodePeersCodec = {
	/**
	 * Parses a node info.
	 * @param {object} parser Parser.
	 * @returns {object} Parsed node info.
	 */
	deserialize: parser => {
		const nodePeers = [];
		while (parser.buffers.numUnprocessedBytes !== 0) {
			nodePeers.push(nodeInfoCodec.deserialize(parser));
		}
		return nodePeers;
	}
};

module.exports = nodePeersCodec;
