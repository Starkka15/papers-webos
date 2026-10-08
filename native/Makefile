# ppzip, the zip helper the Papers service runs. Built with the webOS PDK's
# toolchain; the result goes into the service folder.
#
# Build on a native Linux filesystem (the 2011 toolchain cannot read sources
# from a Windows or network drive).

PDK ?= /opt/PalmPDK
CC = $(PDK)/arm-toolchain/bin/arm-none-linux-gnueabi-gcc
STRIP = $(PDK)/arm-toolchain/bin/arm-none-linux-gnueabi-strip

CFLAGS = -std=gnu99 -O2 -Wall -march=armv7-a -mfpu=neon -mfloat-abi=softfp
# Office files are small; leave out what a 2008 C library may not have.
CFLAGS += -DMINIZ_NO_TIME -D_LARGEFILE64_SOURCE
LDFLAGS = -L$(PDK)/device/lib -Wl,--allow-shlib-undefined

ppzip: ppzip.c miniz.c miniz.h
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ ppzip.c miniz.c
	$(STRIP) $@

clean:
	rm -f ppzip
