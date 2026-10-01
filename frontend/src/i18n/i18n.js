import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './en.json';
import bn from './bn.json';
import hi from './hi.json';
import ur from './ur.json';
import ar from './ar.json';
import es from './es.json';

const resources = {
  en: { translation: en },
  bn: { translation: bn },
  hi: { translation: hi },
  ur: { translation: ur },
  ar: { translation: ar },
  es: { translation: es },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'bn',
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;
