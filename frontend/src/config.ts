const config = {
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

const EMAIL_DISPLAY_NAMES: Record<string, string> = {
  'correoprincipal2021@hotmail.com': 'Fernando',
};

export function displayNameForEmail(email: string): string {
  return EMAIL_DISPLAY_NAMES[email.toLowerCase()] ?? email.split('@')[0] ?? email;
}

export default config;
