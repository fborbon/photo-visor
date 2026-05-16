import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

const CUSTOM_DOMAIN    = 'fotos.forwardforecasting.eu';
const CERT_ARN         = 'arn:aws:acm:us-east-1:295936871972:certificate/08cb3665-2187-4940-b149-b52ebbc0c6e6';

export class PhotoVisorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── S3 Bucket ────────────────────────────────────────────────────────────

    const bucket = new s3.Bucket(this, 'PhotosBucket', {
      bucketName: `photo-visor-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN, // never delete accidentally

      lifecycleRules: [
        {
          // Full-resolution photos: transition to Glacier Instant Retrieval immediately.
          // The ingest script also sets storage class on upload, this is a safety net.
          id: 'photos-to-glacier-instant',
          prefix: 'photos/',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(0),
            },
          ],
        },
        {
          // Thumbnails older than 1 year that haven't been accessed: move to IA.
          // Newly generated thumbs stay in Standard for fast map/timeline loading.
          id: 'old-thumbs-to-ia',
          prefix: 'thumbs/',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(365),
            },
          ],
        },
        {
          // Remove incomplete multipart uploads to avoid phantom charges.
          id: 'abort-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],

      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          // Tightened to CloudFront domain after first deploy (see README output).
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    // ─── CloudFront Cache Policies ────────────────────────────────────────────

    // SPA assets: long-lived, content-hashed filenames handle invalidation.
    const appCachePolicy = new cloudfront.CachePolicy(this, 'AppCachePolicy', {
      cachePolicyName: 'photo-visor-app',
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
    });

    // Thumbnails: cache aggressively, they never change once written.
    const thumbsCachePolicy = new cloudfront.CachePolicy(this, 'ThumbsCachePolicy', {
      cachePolicyName: 'photo-visor-thumbs',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
    });

    // Index JSON files: short TTL so map/timeline refresh after new uploads.
    const indexCachePolicy = new cloudfront.CachePolicy(this, 'IndexCachePolicy', {
      cachePolicyName: 'photo-visor-index',
      defaultTtl: Duration.hours(1),
      maxTtl: Duration.hours(6),
      minTtl: Duration.seconds(0),
    });

    // Full-res photos: very long TTL, originals are immutable.
    const photosCachePolicy = new cloudfront.CachePolicy(this, 'PhotosCachePolicy', {
      cachePolicyName: 'photo-visor-photos',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
    });

    // ─── CloudFront Distribution ──────────────────────────────────────────────

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    const certificate = acm.Certificate.fromCertificateArn(this, 'PhotoCert', CERT_ARN);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Photo Visor CDN',
      defaultRootObject: 'app/index.html',
      domainNames: [CUSTOM_DOMAIN],
      certificate,

      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: appCachePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },

      additionalBehaviors: {
        'thumbs/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: thumbsCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false, // JPEGs don't compress further
        },
        'index/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: indexCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true, // JSON compresses very well
        },
        'photos/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: photosCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: false,
        },
      },

      // SPA: return index.html for all 403/404 so React Router handles routing.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/app/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/app/index.html',
          ttl: Duration.seconds(0),
        },
      ],

      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + Europe only – cheapest
    });

    // ─── Cognito ──────────────────────────────────────────────────────────────

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'photo-visor-users',
      selfSignUpEnabled: false, // admin invites only
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'photo-visor-spa',
      authFlows: {
        userSrp: true, // secure remote password – standard for SPAs
      },
      generateSecret: false, // SPAs can't keep secrets
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // Identity Pool: issues temporary AWS credentials to logged-in users
    // so the SPA can generate pre-signed S3 URLs client-side without a backend.
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: 'photo_visor_identity',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const authenticatedRole = new iam.Role(this, 'CognitoAuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // Authenticated users can read thumbnails, index files, and full-res photos.
    // They cannot list bucket contents or write anything.
    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          `${bucket.bucketArn}/thumbs/*`,
          `${bucket.bucketArn}/index/*`,
          `${bucket.bucketArn}/photos/*`,
        ],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    // ─── EXIF Processor Lambda ────────────────────────────────────────────────
    // Triggered on every new photo upload. Extracts EXIF metadata, generates
    // a 400px thumbnail, and updates the partitioned index JSON files in S3.
    // Full implementation lives in /lambdas/exif-processor/.

    const exifLambda = new lambda.Function(this, 'ExifProcessor', {
      functionName: 'photo-visor-exif-processor',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      // Stub code – replaced during `cdk deploy` once lambdas/exif-processor is built.
      code: lambda.Code.fromInline(`
def handler(event, context):
    print("EXIF processor stub – deploy full code from lambdas/exif-processor/")
    return {"statusCode": 200}
`),
      timeout: Duration.seconds(60),   // Sharp thumbnail generation can be slow for RAW files
      memorySize: 1024,                // More RAM = faster image processing
      environment: {
        BUCKET_NAME: bucket.bucketName,
        THUMB_WIDTH: '400',
        THUMB_QUALITY: '72',
      },
    });

    bucket.grantRead(exifLambda);
    bucket.grantPut(exifLambda);   // writes thumbs/ and updates index/

    // Only trigger on files uploaded to photos/ prefix.
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(exifLambda),
      { prefix: 'photos/' },
    );

    // ─── Stack Outputs ────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket – upload photos here under photos/ prefix',
      exportName: 'PhotoVisorBucket',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${CUSTOM_DOMAIN}`,
      description: 'Photo Visor URL',
      exportName: 'PhotoVisorUrl',
    });

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront origin domain — use this as CNAME target in DNS',
      exportName: 'PhotoVisorCFDomain',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID – used for cache invalidations',
      exportName: 'PhotoVisorDistributionId',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID – add family members here',
      exportName: 'PhotoVisorUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID – used in frontend config',
      exportName: 'PhotoVisorUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID – used for S3 pre-signed URLs',
      exportName: 'PhotoVisorIdentityPoolId',
    });

    new cdk.CfnOutput(this, 'ExifLambdaName', {
      value: exifLambda.functionName,
      description: 'EXIF processor Lambda – update code from lambdas/exif-processor/',
      exportName: 'PhotoVisorExifLambda',
    });
  }
}
