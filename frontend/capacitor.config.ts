import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId:   'com.photovisor.family',
  appName: 'Photo Visor',
  webDir:  'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    Camera: {
      presentationStyle: 'fullscreen',
    },
  },
  android: {
    minWebViewVersion: 80,
  },
};

export default config;
