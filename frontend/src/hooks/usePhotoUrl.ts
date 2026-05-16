import { useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config';

export function usePhotoUrl() {
  const [loading, setLoading] = useState(false);

  const getUrl = useCallback(async (s3Key: string): Promise<string> => {
    setLoading(true);
    try {
      const session     = await fetchAuthSession();
      const credentials = session.credentials;
      if (!credentials) throw new Error('Not authenticated');

      const s3  = new S3Client({ region: config.region, credentials });
      const cmd = new GetObjectCommand({ Bucket: config.bucketName, Key: s3Key });
      return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    } finally {
      setLoading(false);
    }
  }, []);

  return { getUrl, loading };
}
