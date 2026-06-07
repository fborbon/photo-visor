const IS_DEMO = (import.meta.env.VITE_DEMO as string | undefined) === 'true';

const config = IS_DEMO ? {
  cloudFrontUrl:            'https://picsum.photos',
  indexBase:                '/photo-visor',
  bucketName:               'demo',
  cloudFrontDistributionId: '',
  region:                   'eu-west-1',
  userPoolId:               'demo',
  userPoolClientId:         'demo',
  identityPoolId:           'demo',
  ownerEmail:               'demo@demo.com',
} : {
  cloudFrontUrl:            'https://fotos.forwardforecasting.eu',
  indexBase:                'https://fotos.forwardforecasting.eu',
  bucketName:               'photo-visor-295936871972',
  cloudFrontDistributionId: 'E2JW5PYKNPPYOB',
  region:                   'eu-west-1',
  userPoolId:               'eu-west-1_GeFLGEa2J',
  userPoolClientId:         '7u1glr8rup47tejh0n9dlrfqas',
  identityPoolId:           'eu-west-1:8f2feb68-6aba-45df-a996-c3918f9153c7',
  ownerEmail:               'correoprincipal2021@hotmail.com',
};

const EMAIL_DISPLAY_NAMES: Record<string, string> = IS_DEMO ? {} : {
  'correoprincipal2021@hotmail.com': 'Fernando',
  'ferborbon77@hotmail.com':         'Adrián',
  'rogui1900@gmail.com':             'Rosibel',
  'borgui11@gmail.com':              'Katherine',
};

const FEMALE_EMAILS: Set<string> = IS_DEMO ? new Set() : new Set([
  'rogui1900@gmail.com',
  'borgui11@gmail.com',
]);

export function displayNameForEmail(email: string): string {
  return EMAIL_DISPLAY_NAMES[email.toLowerCase()] ?? email.split('@')[0] ?? email;
}

export function isFemaleEmail(email: string): boolean {
  return FEMALE_EMAILS.has(email.toLowerCase());
}

export default config;
