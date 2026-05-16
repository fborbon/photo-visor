import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import config from './config';
import App from './App';
import './index.css';
import 'leaflet/dist/leaflet.css';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId:       config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      identityPoolId:   config.identityPoolId,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
