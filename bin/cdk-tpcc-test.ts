#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkTpccTestStack } from '../lib/cdk-tpcc-test-stack';

const app = new cdk.App();
new CdkTpccTestStack(app, 'CdkTpccTestStack');
