import React, { useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
} from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import {
  Box,
  Container,
} from '@mui/material';
import Home from './pages/Home';
import { AppProvider, useAppContext } from './context/AppContext';

const googleClientId = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'placeholder-disabled';

const Shell = () => {
  const { analysisResults, setShowVerification } = useAppContext();

  useEffect(() => {
    const hasVerificationSignal = Boolean(
      analysisResults?.office_name
      || analysisResults?.ministry
      || analysisResults?.related_ministry
      || analysisResults?.related_office
      || analysisResults?.rti_target_office
      || (Array.isArray(analysisResults?.related_offices) && analysisResults.related_offices.length > 0)
      || (Array.isArray(analysisResults?.matches) && analysisResults.matches.length > 0)
      || analysisResults?.officers
    );
    setShowVerification(hasVerificationSignal);
  }, [analysisResults, setShowVerification]);

  return (
    <Box
      sx={{
        minHeight: '100vh',
        backgroundColor: '#f5eedc',
        backgroundImage:
          'linear-gradient(rgba(255, 255, 255, 0.5), rgba(245, 238, 220, 0.5)), url(/jaani-site-bg.png)',
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }}
    >
      <Container
        maxWidth="lg"
        component="main"
        sx={{ py: { xs: 3, md: 5 }, minHeight: '100vh', pb: { xs: 7, md: 8 } }}
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Container>
    </Box>
  );
};

const App = () => (
  <AppProvider>
    <GoogleOAuthProvider clientId={googleClientId}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </GoogleOAuthProvider>
  </AppProvider>
);

export default App;
