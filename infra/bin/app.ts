#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PhotoVisorStack } from '../lib/photo-visor-stack';

const app = new cdk.App();

new PhotoVisorStack(app, 'PhotoVisorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Photo visor – S3 storage, CloudFront CDN, Cognito auth, EXIF Lambda',
});
