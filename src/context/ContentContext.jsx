import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BACKEND_BASE_URL, contentService } from '../services/api.js';

const ContentContext = createContext();

export const ContentProvider = ({ children }) => {
  const [content, setContent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refreshedMediaUrls = useRef(new Set());

  const loadContent = useCallback(async () => {
    try {
      setLoading(true);
      const res = await contentService.getContent();
      const nextContent = res.data.content || [];
      setContent(nextContent);
      setError(null);
      return nextContent;
    } catch (err) {
      setError('Error loading content');
      console.error(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFreeContent = useCallback(async () => {
    try {
      setLoading(true);
      const res = await contentService.getFreeContent();
      const nextContent = res.data.content || [];
      setContent(nextContent);
      setError(null);
      return nextContent;
    } catch (err) {
      setError('Error loading free content');
      console.error(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Load content on mount
  useEffect(() => {
    loadContent();
  }, [loadContent]);

  const toAbsoluteMediaUrl = useCallback((url) => {
    if (!url || !url.startsWith('/')) return url;
    return `${BACKEND_BASE_URL}${url}`;
  }, []);

  const openContent = useCallback(async (item) => {
    if (!item?.url || typeof window === 'undefined') return;

    let targetUrl = toAbsoluteMediaUrl(item.url);
    const planTier = item.plan_tier || 'basico';
    const isPaid = planTier !== 'free';

    if (!isPaid) {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    // Open synchronously so browsers do not treat the eventual navigation as a popup.
    const mediaWindow = window.open('about:blank', '_blank');
    if (mediaWindow) mediaWindow.opener = null;

    try {
      const response = await fetch(targetUrl, { method: 'HEAD' });
      if (response.status === 401 || response.status === 403) {
        const refreshKey = `${item.id}:${item.url}`;
        if (refreshedMediaUrls.current.has(refreshKey)) {
          setError('El enlace del recurso venció y no pudo renovarse. Recargá la página para intentarlo nuevamente.');
          if (mediaWindow && !mediaWindow.closed) mediaWindow.close();
          return;
        }

        refreshedMediaUrls.current.add(refreshKey);
        const refreshedContent = await loadContent();
        if (!refreshedContent) {
          setError('No se pudo renovar el enlace del recurso. Intentá nuevamente más tarde.');
          if (mediaWindow && !mediaWindow.closed) mediaWindow.close();
          return;
        }

        const refreshedItem = refreshedContent.find((candidate) => candidate.id === item.id);
        if (!refreshedItem) {
          setError('Ya no tenés acceso a este recurso con tu plan actual.');
          if (mediaWindow && !mediaWindow.closed) mediaWindow.close();
          return;
        }

        if (!refreshedItem.url || refreshedItem.url === item.url) {
          setError('El enlace del recurso venció y no pudo renovarse. Recargá la página para intentarlo nuevamente.');
          if (mediaWindow && !mediaWindow.closed) mediaWindow.close();
          return;
        }

        targetUrl = toAbsoluteMediaUrl(refreshedItem.url);
        setError(null);
      } else if (response.ok) {
        setError(null);
      }
    } catch (_error) {
      // Cross-origin providers may not support HEAD/CORS; keep the issued URL in that case.
    }

    if (mediaWindow && !mediaWindow.closed) {
      mediaWindow.location.replace(targetUrl);
    } else {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }, [loadContent, toAbsoluteMediaUrl]);

  const addContent = (newContent) => {
    setContent([newContent, ...content]);
  };

  const removeContent = (id) => {
    setContent(content.filter(item => item.id !== id));
  };

  return (
    <ContentContext.Provider value={{ content, loading, error, loadContent, loadFreeContent, openContent, addContent, removeContent }}>
      {children}
    </ContentContext.Provider>
  );
};

export const useContent = () => {
  const context = useContext(ContentContext);
  if (!context) {
    throw new Error('useContent must be used within ContentProvider');
  }
  return context;
};
