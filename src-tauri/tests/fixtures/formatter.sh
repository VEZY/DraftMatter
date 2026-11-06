#!/bin/sh
case "$*" in
  *--version*) printf 'ruff 0.12.0\n' ;;
  *ruff*format*) sed 's/x=1/x = 1/' ;;
  *styler::style_text*) sed 's/x<-1/x <- 1/' ;;
  *) printf '0.12.0\n' ;;
esac
