#!/bin/bash

set -ex

# Need to run catapult-no-rest before.

# Start catapult-rest.
rest_dir=$(realpath $(dirname "$0"))
rest_port=3000
host_port=3000
container_name=catapult-rest-dev
config=rest.json

cd "$rest_dir"
docker run -e "NODE_ENV=development" \
    --network=docker_default \
    -p $rest_port:$host_port \
    -w /catapult-rest \
    -v "$rest_dir":/catapult-rest \
    -it "techbureau/$container_name" /bin/sh \
    -c "./yarn_setup.sh && cd rest && yarn start:debug resources/$config"
