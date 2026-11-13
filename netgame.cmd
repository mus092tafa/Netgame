@echo off
rem Start the network game:  netgame   (run `netgame install` to use it from anywhere)
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org & exit /b 1)
node "%~dp0bin\netgame.mjs" %*
