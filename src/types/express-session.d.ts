import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: number;

    googleOauthState?: string;
    hubspotOauthState?: string;

    flash?: {
      type: 'success' | 'error';
      message: string;
    };

    hubspotDebug?: {
      hubDomain: string;
      hubUserEmail: string;
      hubId: number;
      scopes: string[];
      expiresIn: number;
    };

    hubspotPeekContacts?: Array<{
      id: string;
      email?: string;
      firstname?: string;
      lastname?: string;
    }>;
  }
}
