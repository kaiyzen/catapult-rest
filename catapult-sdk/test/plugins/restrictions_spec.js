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

const EntityType = require('../../src/model/EntityType');
const ModelSchemaBuilder = require('../../src/model/ModelSchemaBuilder');
const restrictionsPlugin = require('../../src/plugins/restrictions');
const { AccountRestrictionType } = require('../../src/plugins/restrictions');
const test = require('../binaryTestUtils');
const { expect } = require('chai');

describe('restrictions plugin', () => {
	describe('account restriction types enumeration', () => {
		it('contains valid values', () => {
			const accountRestrictionTypeBlockOffset = 128;

			// Assert:
			expect(AccountRestrictionType.addressAllow).to.equal(1);
			expect(AccountRestrictionType.addressBlock).to.equal(1 + accountRestrictionTypeBlockOffset);
			expect(AccountRestrictionType.mosaicAllow).to.equal(2);
			expect(AccountRestrictionType.mosaicBlock).to.equal(2 + accountRestrictionTypeBlockOffset);
			expect(AccountRestrictionType.operationAllow).to.equal(4);
			expect(AccountRestrictionType.operationBlock).to.equal(4 + accountRestrictionTypeBlockOffset);
		});
	});

	describe('register schema', () => {
		// Arrange:
		const builder = new ModelSchemaBuilder();
		const numDefaultKeys = Object.keys(builder.build()).length;
		const modificationTypeSchemas = [
			'accountRestriction.addressModificationType',
			'accountRestriction.mosaicModificationType',
			'accountRestriction.operationModificationType'
		];
		const accountRestrictionSchemas = [
			'accountRestriction.addressAccountRestriction',
			'accountRestriction.mosaicAccountRestriction',
			'accountRestriction.operationAccountRestriction'
		];

		// Act:
		restrictionsPlugin.registerSchema(builder);
		const modelSchema = builder.build();

		// Assert:
		it('adds restrictions system schema', () => {
			expect(Object.keys(modelSchema).length).to.equal(numDefaultKeys + 21);
			expect(modelSchema).to.contain.all.keys([
				'accountRestrictionAddress',
				'accountRestrictionMosaic',
				'accountRestrictionOperation',
				'accountRestrictions',
				'accountRestriction.restrictions',
				'accountRestriction.fallback',
				'mosaicRestrictionAddress',
				'mosaicRestrictionGlobal',
				'mosaicRestriction.mosaicGlobalRestriction',
				'mosaicGlobalRestriction.entry',
				'mosaicGlobalRestriction.entry.restriction',
				'mosaicGlobalRestriction.entry.restriction.restriction',
				'mosaicRestriction.mosaicAddressRestriction',
				'mosaicAddressRestriction.entry',
				'mosaicAddressRestriction.entry.restriction'
			].concat(modificationTypeSchemas).concat(accountRestrictionSchemas));
		});

		it('adds account restrictions schemas', () => {
			// - accountRestrictionAddress
			expect(Object.keys(modelSchema.accountRestrictionAddress).length).to.equal(Object.keys(modelSchema.transaction).length + 1);
			expect(modelSchema.accountRestrictionAddress).to.contain.all.keys(['modifications']);

			// - accountRestrictionMosaic
			expect(Object.keys(modelSchema.accountRestrictionMosaic).length).to.equal(Object.keys(modelSchema.transaction).length + 1);
			expect(modelSchema.accountRestrictionMosaic).to.contain.all.keys(['modifications']);

			// - accountRestrictionOperation
			expect(Object.keys(modelSchema.accountRestrictionOperation).length).to.equal(Object.keys(modelSchema.transaction).length + 1);
			expect(modelSchema.accountRestrictionOperation).to.contain.all.keys(['modifications']);

			// - accountRestrictions
			expect(Object.keys(modelSchema.accountRestrictions).length).to.equal(1);
			expect(modelSchema.accountRestrictions).to.contain.all.keys(['accountRestrictions']);

			// - accountRestriction modification types
			modificationTypeSchemas.forEach(schema => {
				expect(Object.keys(modelSchema[schema]).length).to.equal(1);
				expect(modelSchema[schema]).to.contain.all.keys(['value']);
			});

			// - accountRestriction.restrictions
			expect(Object.keys(modelSchema['accountRestriction.restrictions']).length).to.equal(2);
			expect(modelSchema['accountRestriction.restrictions']).to.contain.all.keys(['address', 'restrictions']);

			// - accountRestriction address, mosaic, and operation restrictions
			accountRestrictionSchemas.forEach(schema => {
				expect(Object.keys(modelSchema[schema]).length).to.equal(1);
				expect(modelSchema[schema]).to.contain.all.keys(['values']);
			});
		});

		it('uses the correct conditional account schema depending on restriction type', () => {
			// Arrange:
			const accountRestrictionSchema = modelSchema['accountRestriction.restrictions'].restrictions.schemaName;

			// Assert:
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.addressAllow }))
				.to.equal('accountRestriction.addressAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.addressBlock }))
				.to.equal('accountRestriction.addressAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.mosaicAllow }))
				.to.equal('accountRestriction.mosaicAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.mosaicBlock }))
				.to.equal('accountRestriction.mosaicAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.operationAllow }))
				.to.equal('accountRestriction.operationAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: AccountRestrictionType.operationBlock }))
				.to.equal('accountRestriction.operationAccountRestriction');
			expect(accountRestrictionSchema({ restrictionType: 99 }))
				.to.equal('accountRestriction.fallback');
		});

		it('adds mosaic restrictions system schema', () => {
			// - mosaic restriction address
			expect(Object.keys(modelSchema.mosaicRestrictionAddress).length).to.equal(Object.keys(modelSchema.transaction).length + 5);
			expect(modelSchema.mosaicRestrictionAddress).to.contain.all.keys([
				'mosaicId',
				'restrictionKey',
				'targetAddress',
				'previousRestrictionValue',
				'newRestrictionValue'
			]);

			// - mosaic restriction global
			expect(Object.keys(modelSchema.mosaicRestrictionGlobal).length).to.equal(Object.keys(modelSchema.transaction).length + 5);
			expect(modelSchema.mosaicRestrictionGlobal).to.contain.all.keys([
				'mosaicId',
				'referenceMosaicId',
				'restrictionKey',
				'previousRestrictionValue',
				'newRestrictionValue'
			]);

			// - mosaic restriction, mosaic global restriction
			expect(Object.keys(modelSchema['mosaicRestriction.mosaicGlobalRestriction']).length).to.equal(1);
			expect(modelSchema['mosaicRestriction.mosaicGlobalRestriction']).to.contain.all.keys([
				'mosaicRestrictionEntry'
			]);

			// - mosaicGlobalRestriction.entry
			expect(Object.keys(modelSchema['mosaicGlobalRestriction.entry']).length).to.equal(3);
			expect(modelSchema['mosaicGlobalRestriction.entry']).to.contain.all.keys([
				'compositeHash',
				'mosaicId',
				'restrictions'
			]);

			// - mosaicGlobalRestriction.entry.restriction
			expect(Object.keys(modelSchema['mosaicGlobalRestriction.entry.restriction']).length).to.equal(2);
			expect(modelSchema['mosaicGlobalRestriction.entry.restriction']).to.contain.all.keys([
				'key',
				'restriction'
			]);

			// - mosaicGlobalRestriction.entry.restriction.restriction
			expect(Object.keys(modelSchema['mosaicGlobalRestriction.entry.restriction.restriction']).length).to.equal(2);
			expect(modelSchema['mosaicGlobalRestriction.entry.restriction.restriction']).to.contain.all.keys([
				'referenceMosaicId',
				'restrictionValue'
			]);

			// - mosaic restriction, mosaic address restriction
			expect(Object.keys(modelSchema['mosaicRestriction.mosaicAddressRestriction']).length).to.equal(1);
			expect(modelSchema['mosaicRestriction.mosaicAddressRestriction']).to.contain.all.keys([
				'mosaicRestrictionEntry'
			]);

			// - mosaicAddressRestriction.entry
			expect(Object.keys(modelSchema['mosaicAddressRestriction.entry']).length).to.equal(4);
			expect(modelSchema['mosaicAddressRestriction.entry']).to.contain.all.keys([
				'compositeHash',
				'mosaicId',
				'targetAddress',
				'restrictions'
			]);

			// - mosaicAddressRestriction.entry.restriction
			expect(Object.keys(modelSchema['mosaicAddressRestriction.entry.restriction']).length).to.equal(2);
			expect(modelSchema['mosaicAddressRestriction.entry.restriction']).to.contain.all.keys([
				'key',
				'value'
			]);
		});
	});

	describe('register codecs', () => {
		const getCodecs = () => {
			const codecs = {};
			restrictionsPlugin.registerCodecs({
				addTransactionSupport: (type, codec) => { codecs[type] = codec; }
			});

			return codecs;
		};

		it('adds restriction codecs (account and mosaic)', () => {
			// Act:
			const codecs = getCodecs();

			// Assert: codecs were registered
			expect(Object.keys(codecs).length).to.equal(5);
			expect(codecs).to.contain.all.keys([
				EntityType.accountRestrictionAddress.toString(),
				EntityType.accountRestrictionMosaic.toString(),
				EntityType.accountRestrictionOperation.toString(),
				EntityType.mosaicRestrictionAddress.toString(),
				EntityType.mosaicRestrictionGlobal.toString()
			]);
		});

		describe('account restrictions codecs', () => {
			const addressCodec = getCodecs()[EntityType.accountRestrictionAddress];
			const mosaicCodec = getCodecs()[EntityType.accountRestrictionMosaic];
			const operationCodec = getCodecs()[EntityType.accountRestrictionOperation];
			const addNoModificationTests = (restrictionType, codec) => {
				const bufferSize = 1 + 1; // account restriction type (in bytes) + modifications count (in bytes)
				test.binary.test.addAll(codec, bufferSize, () => ({
					buffer: Buffer.concat([
						Buffer.of(restrictionType), // account restriction type
						Buffer.of(0x00) // modifications count
					]),
					object: {
						restrictionType,
						modifications: []
					}
				}));
			};
			const addModificationTests = (restrictionType, codec, modBuffers, modValues) => {
				// bufferSize = account restriction type (in bytes) + mods count (in bytes) + (each mod size in bytes) * num mods
				const bufferSize = 1 + 1 + ((1 + modBuffers[0][1].byteLength) * modBuffers.length);

				const concatModificationBuffers = buffers =>
					Buffer.concat(buffers.map(componentBuffers => Buffer.concat(componentBuffers)));

				const splitModificationValues = values => {
					const mods = [];
					for (let i = 0; i < values.length; ++i)
						mods.push({ modificationAction: values[i][0], value: values[i][1] });
					return mods;
				};

				test.binary.test.addAll(codec, bufferSize, () => ({
					buffer: Buffer.concat([
						Buffer.of(restrictionType), // account restriction type
						Buffer.of(modBuffers.length), // modifications count
						concatModificationBuffers(modBuffers) // modification types and values buffers
					]),
					object: {
						restrictionType,
						modifications: splitModificationValues(modValues)
					}
				}));
			};

			describe('supports account address restriction with no modifications', () => {
				addNoModificationTests(AccountRestrictionType.addressAllow, addressCodec);
			});

			describe('supports account mosaic restriction with no modifications', () => {
				addNoModificationTests(AccountRestrictionType.mosaicAllow, mosaicCodec);
			});

			describe('supports account operation restriction with no modifications', () => {
				addNoModificationTests(AccountRestrictionType.operationAllow, operationCodec);
			});

			describe('supports account address restriction with one modification', () => {
				const testAddress = test.random.bytes(test.constants.sizes.addressDecoded);
				addModificationTests(
					AccountRestrictionType.addressAllow,
					addressCodec,
					[[Buffer.of(0x00), Buffer.from(testAddress)]],
					[[0x00, testAddress]]
				);
			});

			describe('supports account mosaic restriction with one modification', () => {
				addModificationTests(
					AccountRestrictionType.mosaicAllow,
					mosaicCodec,
					[[Buffer.of(0x00), Buffer.of(0xF2, 0x26, 0x6C, 0x06, 0x40, 0x83, 0xB2, 0x92)]],
					[[0x00, [0x066C26F2, 0x92B28340]]]
				);
			});

			describe('supports account operation restriction with one modification', () => {
				addModificationTests(
					AccountRestrictionType.operationAllow,
					operationCodec,
					[[Buffer.of(0x02), Buffer.of(0xF2, 0x83)]],
					[[0x02, 0x83F2]]
				);
			});

			describe('supports account address restriction with several modifications', () => {
				const testAddress1 = test.random.bytes(test.constants.sizes.addressDecoded);
				const testAddress2 = test.random.bytes(test.constants.sizes.addressDecoded);
				const testAddress3 = test.random.bytes(test.constants.sizes.addressDecoded);
				addModificationTests(
					AccountRestrictionType.addressAllow,
					addressCodec,
					[
						[Buffer.of(0xD0), Buffer.from(testAddress1)],
						[Buffer.of(0x64), Buffer.from(testAddress2)],
						[Buffer.of(0x32), Buffer.from(testAddress3)]
					],
					[
						[0xD0, testAddress1],
						[0x64, testAddress2],
						[0x32, testAddress3]
					]
				);
			});

			describe('supports account mosaic restriction with several modifications', () => {
				addModificationTests(
					AccountRestrictionType.mosaicAllow,
					mosaicCodec,
					[
						[Buffer.of(0xAB), Buffer.of(0xF2, 0x10, 0x20, 0x0A, 0x40, 0x83, 0xB2, 0x92)],
						[Buffer.of(0xAE), Buffer.of(0xF3, 0x11, 0x12, 0x0B, 0x40, 0x83, 0xB2, 0xE3)],
						[Buffer.of(0x22), Buffer.of(0xF4, 0x12, 0x32, 0x0C, 0x40, 0x83, 0xB2, 0xC0)]
					],
					[
						[0xAB, [0x0A2010F2, 0x92B28340]],
						[0xAE, [0x0B1211F3, 0xE3B28340]],
						[0x22, [0x0C3212F4, 0xC0B28340]]
					]
				);
			});

			describe('supports account operation restriction with several modifications', () => {
				addModificationTests(
					AccountRestrictionType.operationAllow,
					operationCodec,
					[
						[Buffer.of(0x5A), Buffer.of(0xF2, 0x36)],
						[Buffer.of(0x7C), Buffer.of(0xB1, 0x83)],
						[Buffer.of(0x10), Buffer.of(0x13, 0x54)]
					],
					[
						[0x5A, 0x36F2],
						[0x7C, 0x83B1],
						[0x10, 0x5413]
					]
				);
			});
		});

		describe('mosaic restrictions codecs', () => {
			const getCodec = entityType => getCodecs()[entityType];

			describe('supports mosaic restriction address', () => {
				const targetAddress = test.random.bytes(test.constants.sizes.addressDecoded); // 25

				test.binary.test.addAll(getCodec(EntityType.mosaicRestrictionAddress), 57, () => ({
					buffer: Buffer.concat([
						Buffer.of(0xA4, 0x78, 0xB2, 0x05, 0x04, 0x40, 0x38, 0x36), // mosaicId
						Buffer.of(0xFF, 0x12, 0x77, 0x31, 0x82, 0x33, 0x32, 0x29), // restrictionKey
						Buffer.from(targetAddress), // targetAddress 25b
						Buffer.of(0xD3, 0xA1, 0x3E, 0x35, 0x02, 0x22, 0xC5, 0xC4), // previousRestrictionValue
						Buffer.of(0xCC, 0x33, 0xC2, 0x2A, 0x23, 0x32, 0x67, 0xAC) // newRestrictionValue
					]),

					object: {
						mosaicId: [0x05B278A4, 0x36384004],
						restrictionKey: [0x317712FF, 0x29323382],
						targetAddress,
						previousRestrictionValue: [0x353EA1D3, 0xC4C52202],
						newRestrictionValue: [0x2AC233CC, 0xAC673223]
					}
				}));
			});

			describe('supports mosaic restriction global', () => {
				test.binary.test.addAll(getCodec(EntityType.mosaicRestrictionGlobal), 42, () => ({
					buffer: Buffer.concat([
						Buffer.of(0x03, 0xC1, 0xC2, 0x33, 0xB2, 0xFF, 0x23, 0xAC), // mosaicId
						Buffer.of(0x45, 0x32, 0x27, 0xAA, 0x23, 0xC2, 0x2B, 0xEE), // referenceMosaicId
						Buffer.of(0xC4, 0x56, 0x12, 0xB5, 0xF3, 0x3A, 0xA3, 0x01), // restrictionKey
						Buffer.of(0xDD, 0x2E, 0x3C, 0x56, 0x77, 0x7F, 0xF7, 0x7F), // previousRestrictionValue
						Buffer.of(0x01), // previousRestrictionType
						Buffer.of(0x34, 0x03, 0x0F, 0x0C, 0x0C, 0x00, 0x11, 0xB2), // newRestrictionValue
						Buffer.of(0x02) // newRestrictionType
					]),

					object: {
						mosaicId: [0x33C2C103, 0xAC23FFB2],
						referenceMosaicId: [0xAA273245, 0xEE2BC223],
						restrictionKey: [0xB51256C4, 0x01A33AF3],
						previousRestrictionValue: [0x563C2EDD, 0x7FF77F77],
						previousRestrictionType: 0x01,
						newRestrictionValue: [0x0C0F0334, 0xB211000C],
						newRestrictionType: 0x02
					}
				}));
			});
		});
	});
});