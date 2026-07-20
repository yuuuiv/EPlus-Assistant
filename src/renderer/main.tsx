import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    void window.eplusApi?.addLog(`Renderer error: ${error.message}`, "error");
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-screen">
          <h1>界面启动失败</h1>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
