import React, { createContext, useContext, useMemo, useReducer } from 'react';

const detectLanguage = () =>
  typeof navigator !== 'undefined' && navigator.language?.startsWith('bn')
    ? 'bn'
    : 'en';

const initialState = {
  loading: false,
  results: null,
  showVerification: false,
  error: null,
  language: detectLanguage(),
  region: 'BD',
  selectedContact: null,
  emailSubject: '',
  emailBody: '',
  attachments: [],
  tone: 'polite',
};

const ActionTypes = {
  SET_LOADING: 'SET_LOADING',
  SET_RESULTS: 'SET_RESULTS',
  SET_SHOW_VERIFICATION: 'SET_SHOW_VERIFICATION',
  SET_ERROR: 'SET_ERROR',
  SET_LANGUAGE: 'SET_LANGUAGE',
  SET_REGION: 'SET_REGION',
  SET_SELECTED_CONTACT: 'SET_SELECTED_CONTACT',
  SET_EMAIL_SUBJECT: 'SET_EMAIL_SUBJECT',
  SET_EMAIL_BODY: 'SET_EMAIL_BODY',
  SET_ATTACHMENTS: 'SET_ATTACHMENTS',
  SET_TONE: 'SET_TONE',
  RESET: 'RESET',
};

const reducer = (state, action) => {
  switch (action.type) {
    case ActionTypes.SET_LOADING:
      return { ...state, loading: action.payload };
    case ActionTypes.SET_RESULTS:
      return { ...state, results: action.payload, error: null };
    case ActionTypes.SET_SHOW_VERIFICATION:
      return { ...state, showVerification: Boolean(action.payload) };
    case ActionTypes.SET_ERROR:
      return { ...state, error: action.payload, loading: false };
    case ActionTypes.SET_LANGUAGE:
      return { ...state, language: action.payload };
    case ActionTypes.SET_REGION:
      return { ...state, region: action.payload };
    case ActionTypes.SET_SELECTED_CONTACT:
      return { ...state, selectedContact: action.payload };
    case ActionTypes.SET_EMAIL_SUBJECT:
      return { ...state, emailSubject: action.payload };
    case ActionTypes.SET_EMAIL_BODY:
      return { ...state, emailBody: action.payload };
    case ActionTypes.SET_ATTACHMENTS:
      return { ...state, attachments: action.payload };
    case ActionTypes.SET_TONE:
      return { ...state, tone: action.payload };
    case ActionTypes.RESET:
      return { ...initialState, language: state.language, region: state.region };
    default:
      return state;
  }
};

const AppContext = createContext(undefined);

export const AppProvider = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, initialState);

  const resolvePayload = (updater, slice) =>
    typeof updater === 'function' ? updater(slice) : updater;

  const value = useMemo(
    () => ({
      ...state,
      analysisResults: state.results,
      setAnalysisResults: (payload) =>
        dispatch({ type: ActionTypes.SET_RESULTS, payload }),
      setLoading: (payload) =>
        dispatch({ type: ActionTypes.SET_LOADING, payload }),
      setResults: (payload) =>
        dispatch({ type: ActionTypes.SET_RESULTS, payload }),
      setShowVerification: (payload) =>
        dispatch({ type: ActionTypes.SET_SHOW_VERIFICATION, payload }),
      setError: (payload) => dispatch({ type: ActionTypes.SET_ERROR, payload }),
      setLanguage: (payload) =>
        dispatch({ type: ActionTypes.SET_LANGUAGE, payload }),
      setRegion: (payload) =>
        dispatch({ type: ActionTypes.SET_REGION, payload }),
      setSelectedContact: (payload) =>
        dispatch({ type: ActionTypes.SET_SELECTED_CONTACT, payload }),
      setEmailSubject: (payload) =>
        dispatch({ type: ActionTypes.SET_EMAIL_SUBJECT, payload }),
      setEmailBody: (payload) =>
        dispatch({ type: ActionTypes.SET_EMAIL_BODY, payload }),
      setAttachments: (payload) =>
        dispatch({
          type: ActionTypes.SET_ATTACHMENTS,
          payload: resolvePayload(payload, state.attachments),
        }),
      setTone: (payload) => dispatch({ type: ActionTypes.SET_TONE, payload }),
      reset: () => dispatch({ type: ActionTypes.RESET }),
    }),
    [state]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = () => {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return ctx;
};

