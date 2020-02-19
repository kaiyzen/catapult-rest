#!/bin/bash

# Tests to ensure the cursor functionality works as planned.
# This tests every permutation of the the cursors, for the following
# routes:
#
#   Block Routes:
#       /blocks/:duration/:height/limit/:limit
#
#   Transaction Routes:
#       /transactions/:duration/:transaction/limit/:limit
#       /transactions/:duration/:transaction/type/:type/limit/:limit
#       /transactions/:duration/:transaction/type/:type/filter/:filter/limit/:limit
#       /transactions/unconfirmed/:duration/:transaction/limit/:limit
#       /transactions/partial/:duration/:transaction/limit/:limit
#
#   Mosaic Routes:
#       /mosaics/:duration/:mosaic/limit/:limit
#
#   Namespace Routes:
#       /namespaces/:duration/:namespace/limit/:limit
#
#   Account Routes:
#       /accounts/importance/:duration/:account/limit/:limit
#       /accounts/harvested/blocks/:duration/:account/limit/:limit
#       /accounts/harvested/fees/:duration/:account/limit/:limit
#       /accounts/balance/currency/:duration/:account/limit/:limit
#       /accounts/balance/harvest/:duration/:account/limit/:limit
#       /accounts/balance/xem/:duration/:account/limit/:limit
#
#   USAGE
#   =====
#
#   You can pass the following flags and environment variables to override
#   various config options:
#
#   If any of the following variables are set to a non-empty string,
#   it will disable the relevant test.
#       - `DISABLE_BLOCK_TESTS`
#       - `DISABLE_TRANSACTION_TESTS`
#       - `DISABLE_NAMESPACE_TESTS`
#       - `DISABLE_MOSAIC_TESTS`
#       - `DISABLE_ACCOUNT_TESTS`
#
#   For example, running the following snippet will run all tests besides
#   the block tests:
#       `DISABLE_BLOCK_TESTS=1 ./timeline-tests.sh`
#
#   You may override the following config values using the following
#   environment variables, if set to a non-empty string:
#       - `HOST` -- Override `host`
#       - `LIMIT` -- Override `limit`
#       - `BAD_LIMIT` -- Override `bad_limit`
#       - `PYTHON` -- Override `python_exec`


set -ex

# CONFIG

host=localhost:3000
limit=25
bad_limit=0
python_exec=python3

if [ ! -z "$HOST" ]; then
    host="$HOST"
fi
if [ ! -z "$LIMIT" ]; then
    limit="$LIMIT"
fi
if [ ! -z "$BAD_LIMIT" ]; then
    bad_limit="$BAD_LIMIT"
fi
if [ ! -z "$PYTHON" ]; then
    python_exec="$PYTHON"
fi

# KEYWORDS

durations=(
    "from"
    "since"
)

absolute_modifiers=(
    "max"
    "min"
)

time_modifers=(
    "${absolute_modifiers[@]}"
    "latest"
    "earliest"
)

quantity_modifiers=(
    "${absolute_modifiers[@]}"
    "most"
    "least"
)

# Print character from digit.
chr() {
    printf \\$(printf '%03o' $1)
}

# Print digit from character.
ord() {
    printf '%d' "'$1"
}

# Increment a hex character and roll over.
increment_hex() {
    local character="$1"
    case $character in
      [A-E] | [a-e] | [0-8])
        echo $(chr $(($(ord $character) + 1)))
        ;;

      F | f)
        echo "0"
        ;;

      9)
        echo "A"
        ;;

      *)
        exit 1
        ;;
    esac
}

# Generate a bad hex identifier with the same length.
generate_bad_hex_identifier_v1() {
    local identifier="$1"
    local character=$(echo "${identifier: -1}")
    local bad_character=$(increment_hex $character)
    local substr=${identifier:0:-1}
    echo "$substr$bad_character"
}

# Generate a bad hex identifier with a different length.
generate_bad_hex_identifier_v2() {
    local identifier="$1"
    local character=$(echo "${identifier: -1}")
    local bad_character=$(increment_hex $character)
    echo "$identifier$bad_character"
}

# Increment a base32 character and roll over.
increment_base32() {
    local character="$1"
    case $character in
      [A-Y] | [a-y] | [2-6])
        echo $(chr $(($(ord $character) + 1)))
        ;;

      Z | z)
        echo "2"
        ;;

      7)
        echo "A"
        ;;

      *)
        exit 1
        ;;
    esac
}

# Generate a bad base32 identifier with the same length.
generate_bad_base32_identifier_v1() {
    local identifier="$1"
    local character=$(echo "${identifier: -1}")
    local bad_character=$(increment_base32 $character)
    local substr=${identifier:0:-1}
    echo "$substr$bad_character"
}

# Generate a bad base32 identifier with a different length.
generate_bad_base32_identifier_v2() {
    local identifier="$1"
    local character=$(echo "${identifier: -1}")
    local bad_character=$(increment_base32 $character)
    echo "$identifier$bad_character"
}

# Convert hex string to base32.
hex_to_base32() {
    local value="$1"
    $python_exec -c "
import binascii
import base64
encoded = binascii.unhexlify(\"$value\")
print(base64.b32encode(encoded).decode('ascii'))
"
}

# REQUEST UTILITIES

# Make HTTP request and get response body and code.
get_body_and_code() {
    curl "$1" "$2" -w "HTTP_CODE:%{http_code}"
}

# Extract body from the response.
extract_body() {
    echo "$1" | sed -E 's/HTTP_CODE\:[0-9]{3}$//'
}

# Extract body from the response.
extract_code() {
    echo "$1" | tr -d '\n' | sed -E 's/.*HTTP_CODE:([0-9]{3})$/\1/'
}

# Make initial request to get URL to get initial value.
get_initial() {
    local expected_code="$1"
    local url="$2"
    local response=$(get_body_and_code -Ls "$url")
    local body=$(extract_body "$response")
    local code=$(extract_code "$response")
    if [ "$code" = "429" ]; then
        sleep .5s
        response=$(get_body_and_code -Ls "$url")
        body=$(extract_body "$response")
        code=$(extract_code "$response")
    fi
    if [ "$code" != "$expected_code" ]; then
        exit 1
    fi
    echo $body
}

# Make HTTP request and get only HTTP code.
get_code() {
    curl "$1" "$2" -o /dev/null -w "%{http_code}"
}

# Make HTTP request to get URL.
get_timeline() {
    local expected_code="$1"
    local base_url="$2"
    local success_url="$base_url/limit/$limit"
    local redirect_url="$base_url/limit/$bad_limit"

    # Test without a redirect limit.
    local code=$(get_code -s "$success_url")
    if [ "$code" = "429" ]; then
        sleep .5s
        code=$(get_code -s "$success_url")
    fi
    if [ "$code" != "$expected_code" ]; then
        exit 1
    fi

    # Test with a redirect limit.
    local code=$(get_code -s "$redirect_url")
    if [ "$code" = "429" ]; then
        sleep .5s
        code=$(get_code -s "$redirect_url")
    fi
    if [ "$code" != "302" ]; then
        exit 1
    fi

    # Test and redirect with a redirect url.
    local code=$(get_code -Ls "$redirect_url")
    if [ "$code" = "429" ]; then
        sleep .5s
        code=$(get_code -Ls "$redirect_url")
    fi
    if [ "$code" != "$expected_code" ]; then
        exit 1
    fi
}

# Create new URL (missing the limit).
new_url() {
    local path=$1
    local duration=$2
    local value=$3
    echo "$host/$path/$duration/$value"
}

# BLOCKS

# Query our blocks since the beginning, parse the JSON response with jq,
# and extract the first element from the array, and get the block
# height and hash. From there, process all the ID-based and sentinel-based
# queries.
if [ -z "$DISABLE_BLOCK_TESTS" ]; then
    block_list=$(get_initial 200 "$host/blocks/since/min/limit/1")
    block=$(echo $block_list | jq -r '.[0]')
    block_height=$(echo $block | jq -r '.block.height')
    block_hash=$(echo $block | jq -r '.meta.hash')
    bad_block_height_1="0"
    bad_block_height_2="0X"
    bad_block_hash_1=$(generate_bad_hex_identifier_v1 $block_hash)
    bad_block_hash_2=$(generate_bad_hex_identifier_v2 $block_hash)

    # Cursoring by block height.
    for duration in "${durations[@]}"; do
        url=$(new_url blocks $duration $block_height)
        get_timeline 200 "$url"

        url=$(new_url blocks $duration $bad_block_height_1)
        get_timeline 404 "$url"

        url=$(new_url blocks $duration $bad_block_height_2)
        get_timeline 409 "$url"
    done

    # Cursoring by block hash.
    for duration in "${durations[@]}"; do
        url=$(new_url blocks $duration $block_hash)
        get_timeline 200 "$url"

        url=$(new_url blocks $duration $bad_block_hash_1)
        get_timeline 404 "$url"

        url=$(new_url blocks $duration $bad_block_hash_2)
        get_timeline 409 "$url"
    done

    # Cursoring by keywords.
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url blocks $duration $timemod)
            get_timeline 200 "$url"
        done
    done
fi

# TRANSACTIONS

# Query our transactions since the beginning, parse the JSON response with jq,
# and extract the first element from the array, and get the transaction
# ID and hash. From there, process all the ID-based and sentinel-based
# queries.
if [ -z "$DISABLE_TRANSACTION_TESTS" ]; then
    # CONFIRMED TRANSACTIONS

    transaction_list=$(get_initial 200 "$host/transactions/since/min/limit/1")
    transaction=$(echo $transaction_list | jq -r '.[0]')
    transaction_id=$(echo $transaction | jq -r '.meta.id')
    transaction_hash=$(echo $transaction | jq -r '.meta.hash')
    bad_transaction_id_1=$(generate_bad_hex_identifier_v1 $transaction_id)
    bad_transaction_id_2=$(generate_bad_hex_identifier_v2 $transaction_id)
    bad_transaction_hash_1=$(generate_bad_hex_identifier_v1 $transaction_hash)
    bad_transaction_hash_2=$(generate_bad_hex_identifier_v2 $transaction_hash)

    # Cursoring by Hash
    for duration in "${durations[@]}"; do
        url=$(new_url transactions $duration $transaction_hash)
        get_timeline 200 "$url"

        url=$(new_url transactions $duration $bad_transaction_hash_1)
        get_timeline 404 "$url"

        url=$(new_url transactions $duration $bad_transaction_hash_2)
        get_timeline 409 "$url"
    done

    # Cursoring by ID
    for duration in "${durations[@]}"; do
        url=$(new_url transactions $duration $transaction_id)
        get_timeline 200 "$url"

        url=$(new_url transactions $duration $bad_transaction_id_1)
        get_timeline 404 "$url"

        url=$(new_url transactions $duration $bad_transaction_id_2)
        get_timeline 409 "$url"
    done

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url transactions $duration $timemod)
            get_timeline 200 "$url"
        done

        url=$(new_url transactions $duration longest)
        get_timeline 409 "$url"
    done

    # TRANSACTIONS BY TYPE

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url transactions $duration $timemod/type/transfer)
            get_timeline 200 "$url"

            url=$(new_url transactions $duration $timemod/type/registerNamespace)
            get_timeline 200 "$url"
        done

        url=$(new_url transactions $duration longest/type/transfer)
        get_timeline 409 "$url"

        url=$(new_url transactions $duration longest/type/registerNamespace)
        get_timeline 409 "$url"
    done

    # TANSACTIONS BY TYPE WITH FILTER

    # Cursoring by keywords
    # These are really expensive, so only test 1 time modifier.
    url=$(new_url transactions from latest/type/transfer/filter/multisig)
    get_timeline 200 "$url"

    url=$(new_url transactions from latest/type/transfer/filter/mosaic)
    get_timeline 200 "$url"

    # UNCONFIRMED TRANSACTIONS

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url transactions/unconfirmed $duration $timemod)
            get_timeline 200 "$url"
        done

        url=$(new_url transactions/unconfirmed $duration longest)
        get_timeline 409 "$url"

        url=$(new_url transactions/unconfirmed $duration longest)
        get_timeline 409 "$url"
    done

    # PARTIAL TRANSACTIONS

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url transactions/partial $duration $timemod)
            get_timeline 200 "$url"
        done

        url=$(new_url transactions/partial $duration longest)
        get_timeline 409 "$url"

        url=$(new_url transactions/partial $duration longest)
        get_timeline 409 "$url"
    done
fi

# NAMESPACES

# Query our namespaces since the beginning, parse the JSON response with jq,
# and extract the first element from the array, and get the namespace
# ID and object ID. From there, process all the ID-based and sentinel-based
# queries.
if [ -z "$DISABLE_NAMESPACE_TESTS" ]; then
    namespace_list=$(get_initial 200 "$host/namespaces/since/min/limit/1")
    namespace=$(echo $namespace_list | jq -r '.[0]')
    namespace_object_id=$(echo $namespace | jq -r '.meta.id')
    # Highest level ID is the ID of the namespace, so continue until we get
    # non-empty strings.
    namespace_id=$(echo $namespace | jq -r '.namespace.level2')
    if [ "$namespace_id" = "null" ]; then
        namespace_id=$(echo $namespace | jq -r '.namespace.level1')
    fi
    if [ "$namespace_id" = "null" ]; then
        namespace_id=$(echo $namespace | jq -r '.namespace.level0')
    fi

    bad_namespace_id_1=$(generate_bad_hex_identifier_v1 $namespace_id)
    bad_namespace_id_2=$(generate_bad_hex_identifier_v2 $namespace_id)
    bad_namespace_object_id_1=$(generate_bad_hex_identifier_v1 $namespace_object_id)
    bad_namespace_object_id_2=$(generate_bad_hex_identifier_v2 $namespace_object_id)

    # Cursoring by Object ID
    for duration in "${durations[@]}"; do
        url=$(new_url namespaces $duration $namespace_object_id)
        get_timeline 200 "$url"

        url=$(new_url namespaces $duration $bad_namespace_object_id_1)
        get_timeline 404 "$url"

        url=$(new_url namespaces $duration $bad_namespace_object_id_2)
        get_timeline 409 "$url"
    done

    # Cursoring by Namespace ID
    for duration in "${durations[@]}"; do
        url=$(new_url namespaces $duration $namespace_id)
        get_timeline 200 "$url"

        url=$(new_url namespaces $duration $bad_namespace_id_1)
        get_timeline 404 "$url"

        url=$(new_url namespaces $duration $bad_namespace_id_2)
        get_timeline 409 "$url"
    done

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url namespaces $duration $timemod)
            get_timeline 200 "$url"
        done

        url=$(new_url namespaces $duration longest)
        get_timeline 409 "$url"
    done
fi

# MOSAICS

# Query our mosaics since the beginning, parse the JSON response with jq,
# and extract the first element from the array, and get the mosaic
# ID. From there, process all the ID-based and sentinel-based squeries.
if [ -z "$DISABLE_MOSAIC_TESTS" ]; then
    mosaic_list=$(get_initial 200 "$host/mosaics/since/min/limit/1")
    mosaic=$(echo $mosaic_list | jq -r '.[0]')
    mosaic_id=$(echo $mosaic | jq -r '.mosaic.id')
    bad_mosaic_id_1=$(generate_bad_hex_identifier_v1 $mosaic_id)
    bad_mosaic_id_2=$(generate_bad_hex_identifier_v2 $mosaic_id)

    # Cursoring by Mosaic ID
    for duration in "${durations[@]}"; do
        url=$(new_url mosaics $duration $mosaic_id)
        get_timeline 200 "$url"

        url=$(new_url mosaics $duration $bad_mosaic_id_1)
        get_timeline 404 "$url"

        url=$(new_url mosaics $duration $bad_mosaic_id_2)
        get_timeline 409 "$url"
    done

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for timemod in "${time_modifers[@]}"; do
            url=$(new_url mosaics $duration $timemod)
            get_timeline 200 "$url"
        done

        url=$(new_url mosaics $duration longest)
        get_timeline 409 "$url"
    done
fi

# ACCOUNTS

# Test all timeline methods for a subpath of accounts.
test_account() {
    local path=$1
    # Cursoring by Base32 Address.
    for duration in "${durations[@]}"; do
        url=$(new_url accounts/$path $duration $account_address)
        get_timeline 200 "$url"

        url=$(new_url accounts/$path $duration $bad_account_address_1)
        get_timeline 404 "$url"

        url=$(new_url accounts/$path $duration $bad_account_address_2)
        get_timeline 409 "$url"
    done

    # Cursoring by Hex Address.
    for duration in "${durations[@]}"; do
        url=$(new_url accounts/$path $duration $account_hex_address)
        get_timeline 200 "$url"

        url=$(new_url accounts/$path $duration $bad_account_hex_address_1)
        get_timeline 404 "$url"

        url=$(new_url accounts/$path $duration $bad_account_hex_address_2)
        get_timeline 409 "$url"
    done

    # Cursoring by Public Key.
    for duration in "${durations[@]}"; do
        url=$(new_url accounts/$path $duration $account_public_key)
        get_timeline 200 "$url"

        url=$(new_url accounts/$path $duration $bad_account_public_key_1)
        get_timeline 404 "$url"

        url=$(new_url accounts/$path $duration $bad_account_public_key_2)
        get_timeline 409 "$url"
    done

    # Cursoring by keywords
    for duration in "${durations[@]}"; do
        for quantmod in "${quantity_modifiers[@]}"; do
            url=$(new_url accounts/$path $duration $quantmod)
            get_timeline 200 "$url"
        done

        url=$(new_url accounts/$path $duration longest)
        get_timeline 409 "$url"
    done
}

# Query our accounts since the beginning, parse the JSON response with jq,
# and extract the first element from the array, and get the account
# address, hex address, and the public key. From there, process all the
# ID-based and sentinel-based squeries.
if [ -z "$DISABLE_ACCOUNT_TESTS" ]; then
    account_list=$(get_initial 200 "$host/accounts/importance/from/max/limit/1")
    account=$(echo $account_list | jq -r '.[0]')
    account_hex_address=$(echo $account | jq -r '.account.address')
    account_public_key=$(echo $account | jq -r '.account.publicKey')
    account_address=$(hex_to_base32 $account_hex_address)
    bad_account_address_1=$(generate_bad_base32_identifier_v1 $account_address)
    bad_account_address_2=$(generate_bad_base32_identifier_v2 $account_address)
    bad_account_hex_address_1=$(generate_bad_hex_identifier_v1 $account_hex_address)
    bad_account_hex_address_2=$(generate_bad_hex_identifier_v2 $account_hex_address)
    bad_account_public_key_1=$(generate_bad_hex_identifier_v1 $account_public_key)
    bad_account_public_key_2=$(generate_bad_hex_identifier_v2 $account_public_key)

    test_account importance
    test_account harvested/blocks
    test_account harvested/fees

    # Need to determine if this is a public or private node.
    # On public nodes, we will use `balance/xem`.
    # On private nodes, we will use `balance/currency` and `balance/harvest`.
    url="$host/accounts/balance/xem/from/max/limit/1"
    http_code=$(curl -Ls "$url" -o /dev/null -w "%{http_code}")
    if [ "$http_code" = "429" ]; then
        sleep .5s
        http_code=$(curl -Ls "$url" -o /dev/null -w "%{http_code}")
    fi

    if [ "$http_code" = "404" ]; then
        # Private network
        test_account balance/currency
        test_account balance/harvest
    elif [ "$http_code" = "200" ]; then
        # Public network
        test_account balance/xem
    else
        # Network error
        exit 1
    fi
fi
