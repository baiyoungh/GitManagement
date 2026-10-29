import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { isTauri } from '@tauri-apps/api/core';
import './i18n';
import './styles.css';
import { App } from './App';
import { NotInTauri } from './components/NotInTauri';
import { queryClient } from './api/queries';

// localhost:1420 只是给 Tauri 窗口提供页面的开发服务器；
// 在普通浏览器中打开时没有后端（invoke / 目录选择对话框均不可用），只显示提示。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isTauri() ? (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    ) : (
      <NotInTauri />
    )}
  </React.StrictMode>,
);
