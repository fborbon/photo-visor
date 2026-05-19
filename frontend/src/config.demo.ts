// Demo build config — dummy data only, no real AWS resources.
const config = {
  cloudFrontUrl:    'https://picsum.photos',  // thumb = 'seed/<hash>/400/300' → valid picsum URL
  indexBase:        '/photo-visor',           // JSON index fetches (useIndex + SlotMachine direct fetch)
  bucketName:       'demo',
  region:           'eu-west-1',
  userPoolId:       'demo',
  userPoolClientId: 'demo',
  identityPoolId:   'demo',
  ownerEmail:       'demo@demo.com',
};

export default config;
