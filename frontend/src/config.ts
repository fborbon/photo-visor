const IS_DEMO = (import.meta.env.VITE_DEMO as string | undefined) === 'true';

const config = IS_DEMO ? {
  cloudFrontUrl:            'https://picsum.photos',
  indexBase:                '/photo-visor',
  webAppUrl:                '/photo-visor',
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
  webAppUrl:                'https://fotos.forwardforecasting.eu/app',
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
  'beguinir@hotmail.com':            'Beatriz',
  'beatriz_dummy@test.com':          'Beatriz (test)',
};

const FEMALE_EMAILS: Set<string> = IS_DEMO ? new Set() : new Set([
  'rogui1900@gmail.com',
  'borgui11@gmail.com',
  'beguinir@hotmail.com',
  'beatriz_dummy@test.com',
]);

// Per-user date cutoffs: users can only see photos from this date onwards.
const USER_DATE_CUTOFFS: Record<string, string> = IS_DEMO ? {} : {
  'beguinir@hotmail.com': '2016-12-01',
  'beatriz_dummy@test.com': '2016-12-01',
};

// Per-user private folder exceptions: allow specific non-owner users to see
// private folders (normally owner-only). Each entry lists allowed prefixes
// and excluded sub-prefixes.
interface FolderAccess { allow: string[]; deny: string[]; }
const USER_FOLDER_ACCESS: Record<string, FolderAccess> = IS_DEMO ? {} : {
  'beguinir@hotmail.com': {
    allow: ['.Amigos/España/Olloki/Beatriz/'],
    deny:  ['.Amigos/España/Olloki/Beatriz/Otros/'],
  },
  'beatriz_dummy@test.com': {
    allow: ['.Amigos/España/Olloki/Beatriz/'],
    deny:  ['.Amigos/España/Olloki/Beatriz/Otros/'],
  },
};

export function displayNameForEmail(email: string): string {
  return EMAIL_DISPLAY_NAMES[email.toLowerCase()] ?? email.split('@')[0] ?? email;
}

export function isFemaleEmail(email: string): boolean {
  return FEMALE_EMAILS.has(email.toLowerCase());
}

export function getDateCutoff(email: string): string | null {
  return USER_DATE_CUTOFFS[email.toLowerCase()] ?? null;
}

export function getFolderAccess(email: string): FolderAccess | null {
  return USER_FOLDER_ACCESS[email.toLowerCase()] ?? null;
}

export function isTagAllowedForUser(tagName: string, access: FolderAccess | null): boolean {
  if (!access) return false;
  const match = access.allow.some(prefix => tagName.startsWith(prefix));
  if (!match) return false;
  const tag = tagName.endsWith('/') ? tagName : tagName + '/';
  return !access.deny.some(prefix => tag.startsWith(prefix));
}

export function getAllowedPrefixes(access: FolderAccess | null): string[] {
  return access?.allow ?? [];
}

export default config;
