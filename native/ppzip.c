/*
 * ppzip - the zip helper for Papers.
 *
 * The TouchPad's own unzip (BusyBox 1.17) cannot read archives written in one
 * pass ("zip flags 1 and 8 are not supported"), which is how many current
 * programs write office files, and it stops when the storage refuses to take
 * permissions. This reads any ordinary zip with miniz.
 *
 *   ppzip x <archive> <folder>    unpack everything into the folder
 *   ppzip l <archive>             list what is inside
 *
 * Exit status 0 on success, 1 for a bad archive, 2 for a bad command.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>

#include "miniz.h"

#define MAX_PATH_LEN 1024

/* A member's name must stay inside the folder it is unpacked into. */
static int safe_name(const char *name)
{
	const char *p = name;

	if (name[0] == '\0' || name[0] == '/' || strchr(name, '\\') != NULL) {
		return 0;
	}
	while (*p != '\0') {
		const char *end = strchr(p, '/');
		size_t len = end != NULL ? (size_t) (end - p) : strlen(p);
		if (len == 2 && p[0] == '.' && p[1] == '.') {
			return 0;
		}
		if (end == NULL) {
			break;
		}
		p = end + 1;
	}
	return 1;
}

/* Make the folders leading to a file. The storage is FAT, so no permissions are
   set afterward, and a folder that is already there is fine. */
static void make_parents(char *path)
{
	char *p;

	for (p = path + 1; *p != '\0'; p++) {
		if (*p == '/') {
			*p = '\0';
			mkdir(path, 0755);
			*p = '/';
		}
	}
}

static int list(mz_zip_archive *zip)
{
	mz_uint i, count = mz_zip_reader_get_num_files(zip);

	for (i = 0; i < count; i++) {
		mz_zip_archive_file_stat st;
		if (!mz_zip_reader_file_stat(zip, i, &st)) {
			return 1;
		}
		printf("%10lu  %s\n", (unsigned long) st.m_uncomp_size, st.m_filename);
	}
	return 0;
}

static int extract(mz_zip_archive *zip, const char *folder)
{
	mz_uint i, count = mz_zip_reader_get_num_files(zip);
	char path[MAX_PATH_LEN];
	int failed = 0;

	for (i = 0; i < count; i++) {
		mz_zip_archive_file_stat st;
		if (!mz_zip_reader_file_stat(zip, i, &st)) {
			return 1;
		}
		if (mz_zip_reader_is_file_a_directory(zip, i) || !safe_name(st.m_filename)) {
			continue;
		}
		if (snprintf(path, sizeof(path), "%s/%s", folder, st.m_filename) >= (int) sizeof(path)) {
			continue;
		}
		make_parents(path);
		if (!mz_zip_reader_extract_to_file(zip, i, path, 0)) {
			fprintf(stderr, "ppzip: %s: %s\n", st.m_filename,
			        mz_zip_get_error_string(mz_zip_get_last_error(zip)));
			failed = 1;
		}
	}
	return failed;
}

int main(int argc, char *argv[])
{
	mz_zip_archive zip;
	int result;

	if (argc < 3 || (argv[1][0] != 'x' && argv[1][0] != 'l') || (argv[1][0] == 'x' && argc < 4)) {
		fprintf(stderr, "usage: ppzip x <archive> <folder> | ppzip l <archive>\n");
		return 2;
	}

	memset(&zip, 0, sizeof(zip));
	if (!mz_zip_reader_init_file(&zip, argv[2], 0)) {
		fprintf(stderr, "ppzip: %s: %s\n", argv[2], mz_zip_get_error_string(mz_zip_get_last_error(&zip)));
		return 1;
	}

	if (argv[1][0] == 'l') {
		result = list(&zip);
	} else {
		mkdir(argv[3], 0755);
		result = extract(&zip, argv[3]);
	}

	mz_zip_reader_end(&zip);
	return result;
}
