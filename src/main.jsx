import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Thumbnail from './Thumbnail.jsx';
import { useRoute } from './router.jsx';
import './styles.css';

function Root() {
  const path = useRoute();
  return path === '/thumbnail' ? <Thumbnail path={path} /> : <App path={path} />;
}

createRoot(document.getElementById('root')).render(<Root />);
