# Working with Timelines

Ok, I have the REST API functional for what we need:
https://github.com/Alexhuszagh/catapult-rest/tree/release

This interfaces on the MongoDB layer and adds a whole lot of functionality that should simplify the explorer considerably.

*Blocks*

For example, to query the latest 25 blocks from the REST API, we can do:
```
GET $endpoint/blocks/from/latest/limit/25
```

This will always return 25 blocks if the chain height is > 25, which fixes numerous issues we were having in the views.

Now, say we want to get the next page, and we have an array of blocks in descending order. We calculate the height (as `$height`) for the earliest block we currently have. We can now do:
```
GET $endpoint/blocks/from/$height/limit/25
```

This will return the 25 blocks preceeding the block at height `$height` on the chain, non-inclusive, so we do not return redundant data.

Now, say we want to get the previous page, and have the height (as `$height`) of the latest block we currently have.  We can now do:
```
GET $endpoint/blocks/since/$height/limit/25
```

Once again, this avoids redundant data, so all the data returned will not be in the same view.

*Transactions*

We're not limited to blocks either. For example, to query the latest 25 confirmed transactions from the REST API, we can do:
```
GET $endpoint/transactions/from/latest/limit/25
```

Now, say we want to get the next page, and we have a transaction hash or ID (as `$transaction`). We can do:
```
GET $endpoint/transactions/from/$transaction/limit/25
```

Now, say we want to get the previous page, and have a transaction hash or ID (as `$transaction`). We can do:
```
GET $endpoint/transactions/since/$transaction/limit/25
```

*Details*

This is an example of working with timelines, which the Twitter API describes fairly well in an abstract sense:
https://developer.twitter.com/en/docs/tweets/timelines/guides/working-with-timelines

We provide two duration keywords: `from` and `since`, which allow us to query data _from_ (before or below, non-inclusive) a parameter, or _since_ (after or above, non-inclusive). This allows to fetch previous and next pages with ease.

Next, we provide keywords for absolutes: when working with blocks, transactions, namespaces, and mosaics (which are sorted by time), we provide the keywords `earliest` and `latest`. For accounts (which are sorted by quantity), we provide the keywords `most` and `least`.

Next, we have a configurable limit. By default, any value from `1-100` will work, with the default being `25`.

From these basic building-blocks, we can implement a large array of functionality quite simply.

*Implemented Routes*

_Unconfirmed Transactions:_
- `/transactions/unconfirmed/from/$transaction/limit/$limit`
- `/transactions/unconfirmed/since/$transaction/limit/$limit`

_Partial Transactions:_
- `/transactions/partial/from/$transaction/limit/$limit`
- `/transactions/partial/since/$transaction/limit/$limit`

_Transactions Filtered By Type:_
- `/transactions/from/$transaction/type/$type/limit/$limit`
- `/transactions/since/$transaction/type/$type/limit/$limit`

_Mosaics:_
- `/mosaics/from/$mosaic/limit/$limit`
- `/mosaics/since/$mosaic/limit/$limit`

_Namespaces:_
- `/namespaces/from/$namespace/limit/$limit`
- `/namespaces/since/$namespace/limit/$limit`

_Accounts:_
- `/accounts/importance/from/$account/limit/$limit`
- `/accounts/importance/since/$account/limit/$limit`
- `/accounts/harvested/blocks/from/$account/limit/$limit`
- `/accounts/harvested/blocks/since/$account/limit/$limit`
- `/accounts/harvested/fees/from/$account/limit/$limit`
- `/accounts/harvested/fees/since/$account/limit/$limit`
- `/accounts/balance/currency/from/$account/limit/$limit`
- `/accounts/balance/currency/since/$account/limit/$limit`
- `/accounts/balance/harvest/from/$account/limit/$limit`
- `/accounts/balance/harvest/since/$account/limit/$limit`

*Examples*

To get the latest 25 transfer transactions, we may do:

```
GET $endpoint/transactions/from/latest/type/transfer/limit/25
```

To get the get the 25 richest accounts by the network currency mosaic, we may do:

```
GET $endpoint/accounts/balance/currency/from/most/limit/25
```
