@echo off
rem Agent entry point: claude mcp add scanruler -- "<this folder>\scanruler-mcp.cmd"
set ELECTRON_RUN_AS_NODE=1
set SCANRULER_MCP_NO_UPDATE=1
"%~dp0ScanRuler.exe" "%~dp0resources\agent-bridge.mjs" %*
